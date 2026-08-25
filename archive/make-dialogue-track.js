// Builds the spoken track for a reel from the prompt's DIALOGUE block.
//
// Speech is synthesised here rather than by the video model, which rejects any prompt
// asking for more than two lines in eight seconds and silently drops the last line even
// under that. Off the model there is no ceiling: every word lands, the brand is
// pronounced correctly, and the only limit is the runtime.
//
// Usage: node make-dialogue-track.js <prompt-out.md> <out.wav>

import "dotenv/config";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { GoogleGenAI } from "@google/genai";

const [, , src, out] = process.argv;
if (!src || !out) { console.error("usage: node make-dialogue-track.js <prompt-out.md> <out.wav>"); process.exit(1); }

const MODEL = process.env.TTS_MODEL || "gemini-2.5-flash-preview-tts";
// Two speakers, two voices. Without this every line sounds like the same person.
const VOICES = { A: process.env.VOICE_A || "Kore", B: process.env.VOICE_B || "Puck" };
const TMP = "prompts/_dlg";
fs.mkdirSync(TMP, { recursive: true });

/** Gemini TTS returns headerless 24kHz mono PCM. */
function wrapWav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const md = fs.readFileSync(src, "utf8");
const block = md.slice(md.indexOf("DIALOGUE"));
const lines = [...block.matchAll(/^\s*(\d{1,2}):(\d{2}(?:\.\d)?)\s+([AB])\s+"([^"]+)"/gm)]
  .map((m) => ({ at: Number(m[1]) * 60 + Number(m[2]), who: m[3], text: m[4] }));

if (!lines.length) { console.error("no DIALOGUE lines found in " + src); process.exit(1); }

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function speak(text, voice, file) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await ai.models.generateContent({
      model: MODEL,
      contents: [{ parts: [{ text }] }],
      config: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    });
    // TTS occasionally returns a candidate with no audio part. Retrying is cheaper than
    // dropping a line, and a dropped line is usually the brand or the CTA.
    const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (part) {
      const pcm = Buffer.from(part.inlineData.data, "base64");
      fs.writeFileSync(file, wrapWav(pcm));
      return pcm.length / 48000;
    }
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  throw new Error("TTS returned no audio after 3 attempts: " + text.slice(0, 40));
}

// The prompt's timings are a guess: the writer cannot know how long a line will take to
// speak. So they fix the ORDER, and the real durations fix the placement. Lines that
// would collide are pushed later rather than allowed to overlap into mush.
const GAP = Number(process.env.LINE_GAP || 0.35);
// The picture is a fixed length. A track longer than it does not play slower, it gets
// cut - and what gets cut is the end, where the brand line and the CTA live. So when the
// script overruns, lines are dropped from the middle and the ones that carry the message
// are kept.
const FIT = Number(process.env.FIT || 0);
const PROTECTED = /travafa/i;
let queue = lines;
if (FIT) {
  // synthesise nothing yet - estimate at 3.1s per line plus a gap, then trim
  const est = (n) => n * 3.1 + (n - 1) * GAP;
  while (est(queue.length) > FIT && queue.length > 2) {
    const droppable = queue.map((l, i) => ({ l, i })).filter((x) => !PROTECTED.test(x.l.text));
    if (!droppable.length) break;
    const mid = droppable[Math.floor(droppable.length / 2)];
    console.log(`  dropped to fit ${FIT}s: "${mid.l.text}"`);
    queue = queue.filter((_, i) => i !== mid.i);
  }
}

const placed = [];
let cursor = 0;

for (const [i, l] of queue.entries()) {
  const file = `${TMP}/${String(i).padStart(2, "0")}-${l.who}.wav`;
  const secs = await speak(l.text, VOICES[l.who], file);
  const at = Math.max(i === 0 ? l.at : 0, cursor);
  const pushed = at > l.at ? `  (moved +${(at - l.at).toFixed(1)}s to clear the line before)` : "";
  placed.push({ file, at, secs });
  cursor = at + secs + GAP;
  console.log(`  ${String(at.toFixed(1)).padStart(5)}s  ${l.who}  ${secs.toFixed(1)}s  "${l.text}"${pushed}`);
}

const total = Math.max(...placed.map((p) => p.at + p.secs)) + 0.5;
const inputs = placed.flatMap((p) => ["-i", p.file]);
const delays = placed.map((p, i) => `[${i}:a]adelay=${Math.round(p.at * 1000)}|${Math.round(p.at * 1000)}[d${i}]`).join(";");
const mix = placed.map((_, i) => `[d${i}]`).join("") + `amix=inputs=${placed.length}:normalize=0:duration=longest[vo]`;

execFileSync(ffmpegPath, ["-hide_banner", "-v", "error", "-y", ...inputs,
  "-filter_complex", `${delays};${mix};[vo]apad,atrim=0:${total.toFixed(2)},aresample=48000[a]`,
  "-map", "[a]", "-c:a", "pcm_s16le", out]);

console.log(`\ndialogue track → ${out}  (${placed.length} lines, ${total.toFixed(1)}s of speech)`);
if (total > 16.5) console.log(`  the track runs past the 16s of picture - the last ${(total - 16).toFixed(1)}s will be cut`);
