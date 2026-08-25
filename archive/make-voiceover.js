// Builds the narration track for a reel.
//
// The voiceover is generated here rather than by the video model, which returned silence
// for every off-screen-narration test. Doing it separately also buys the thing that makes
// six fast cuts read as one film: a line that keeps talking across a cut.
//
// Each beat's line is synthesised on its own and placed at that beat's start time, so the
// words land with the picture and the caption they belong to. Generating the whole script
// as one utterance sounds smoother but drifts out of sync with the edit.
//
// Usage: node make-voiceover.js <beats-out.json> <out.wav>

import "dotenv/config";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { GoogleGenAI } from "@google/genai";

const [, , src, out] = process.argv;
if (!src || !out) { console.error("usage: node make-voiceover.js <beats-out.json> <out.wav>"); process.exit(1); }

const TTS_MODEL = process.env.TTS_MODEL || "gemini-2.5-flash-preview-tts";
const VOICE = process.env.TTS_VOICE || "Kore";
const TMP = "prompts/_vo";
fs.mkdirSync(TMP, { recursive: true });

/** Gemini TTS returns headerless 24kHz mono PCM; ffmpeg needs a container. */
function wrapWav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const { output } = JSON.parse(fs.readFileSync(src, "utf8"));
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

let cursor = 0;
const placed = [];
for (const beat of output.beats) {
  const start = cursor;
  cursor += beat.use_seconds;
  const line = (beat.voiceover || "").trim();
  if (!line) continue;

  const res = await ai.models.generateContent({
    model: TTS_MODEL,
    contents: [{ parts: [{ text: line }] }],
    config: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } } },
  });
  const part = res.candidates[0].content.parts.find((p) => p.inlineData);
  const pcm = Buffer.from(part.inlineData.data, "base64");
  const file = `${TMP}/${beat.id}.wav`;
  fs.writeFileSync(file, wrapWav(pcm));
  const secs = pcm.length / 48000;
  placed.push({ file, start, secs, id: beat.id });
  const over = secs > beat.use_seconds;
  console.log(`  ${beat.id.padEnd(8)} ${secs.toFixed(1)}s of ${beat.use_seconds}s${over ? "  ← runs past its beat" : ""}`);
}

const total = cursor;
const inputs = placed.flatMap((p) => ["-i", p.file]);
// Each line is delayed to its beat, then everything is mixed onto one silent bed of the
// reel's length. normalize=0 keeps a line from being quietened just because it overlaps.
const chains = placed.map((p, i) => `[${i}:a]adelay=${Math.round(p.start * 1000)}|${Math.round(p.start * 1000)}[d${i}]`).join(";");
const mix = placed.map((_, i) => `[d${i}]`).join("") + `amix=inputs=${placed.length}:normalize=0:duration=longest[vo]`;

execFileSync(ffmpegPath, ["-hide_banner", "-v", "error", "-y", ...inputs,
  "-filter_complex", `${chains};${mix};[vo]apad,atrim=0:${total},aresample=48000[a]`,
  "-map", "[a]", "-c:a", "pcm_s16le", out]);

console.log(`\nnarration → ${out}  (${placed.length} lines, ${total}s)`);
