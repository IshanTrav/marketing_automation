// Verifies that generated speech is actually intelligible, by transcribing the clip's
// audio with Gemini and diffing it against the line we asked Veo to say.
// If a transcriber cannot make out the words, a viewer scrolling with the sound low
// certainly cannot.
//
// Usage: node check-speech.js <video.mp4> "<expected line>" ["<expected line 2>"]

import "dotenv/config";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { GoogleGenAI } from "@google/genai";

const [, , video, ...expected] = process.argv;
if (!video) { console.error('usage: node check-speech.js <video.mp4> "<expected line>"'); process.exit(1); }

const wav = "/tmp/_speech.wav";
execFileSync(ffmpegPath, ["-hide_banner", "-v", "error", "-y", "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const res = await ai.models.generateContent({
  model: "gemini-3.7-flash",
  contents: [{
    parts: [
      { text: "Transcribe every spoken word in this audio, verbatim. If a word is unclear, write it as [unclear]. If there is no speech at all, reply exactly: NO SPEECH. Reply with the transcript only." },
      { inlineData: { mimeType: "audio/wav", data: fs.readFileSync(wav).toString("base64") } },
    ],
  }],
});

const heard = res.text.trim();
console.log(`file:     ${video}`);
console.log(`expected: ${expected.join(" | ") || "(none given)"}`);
console.log(`heard:    ${heard}`);

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
const want = norm(expected.join(" "));
const got = new Set(norm(heard));
if (want.length) {
  const hit = want.filter((w) => got.has(w));
  const missed = want.filter((w) => !got.has(w));
  const pct = Math.round((hit.length / want.length) * 100);
  console.log(`\nword recall: ${hit.length}/${want.length} (${pct}%)`);
  if (missed.length) console.log(`missed:      ${missed.join(", ")}`);
  console.log(pct >= 85 ? "verdict:     intelligible ✓" : pct >= 60 ? "verdict:     partly intelligible ⚠" : "verdict:     not intelligible ✗");
}

// The brand name cannot be judged from the word-level transcript. Speech recognition
// normalises an unknown brand to a known one - "Travafa" comes back as "Travala", a
// real competitor - so a word-match check reports a failure that is not there. Ask for
// the sounds instead, with word correction explicitly disabled.
if (/travafa/i.test(expected.join(" "))) {
  const phonetic = await ai.models.generateContent({
    model: "gemini-3.7-flash",
    contents: [{
      parts: [
        { text: "A brand name is spoken in this audio. Transcribe that word PHONETICALLY, syllable by syllable, exactly as the sounds occur. Do NOT correct it to a real word or a known brand. Reply with the syllables only, like tra-va-fa." },
        { inlineData: { mimeType: "audio/wav", data: fs.readFileSync(wav).toString("base64") } },
      ],
    }],
  });
  const syllables = phonetic.text.trim().toLowerCase().replace(/[^a-z]/g, "");
  const ok = syllables.includes("travafa");
  console.log(`\nbrand name:  ${ok ? "pronounced correctly ✓" : "MISPRONOUNCED ✗"}  (heard: ${phonetic.text.trim()})`);
}
