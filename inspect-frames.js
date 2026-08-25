// Looks at what was actually generated.
//
// Everything else in this pipeline checks the *prompt*. Nothing checked the video, so a
// drifting face, a garbled screen or a stray caption shipped exactly as easily as a good
// take. The prompt's own self-check cannot help here: it has passed itself wrongly at
// least four times, and it never sees a frame.
//
// Frames go to a vision model with one question each, and the answers come back typed so
// a failure can gate a regeneration rather than being read by a person.
//
// Usage: node inspect-frames.js <video.mp4> [reference.png] [--json out.json]

import "dotenv/config";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { GoogleGenAI } from "@google/genai";

const args = process.argv.slice(2);
const video = args[0];
const reference = args.find((a) => /\.(png|jpe?g)$/i.test(a)) || "assets/ref/traveller.png";
const jsonIdx = args.indexOf("--json");
if (!video) { console.error("usage: node inspect-frames.js <video.mp4> [reference.png] [--json out.json]"); process.exit(1); }

const MODEL = process.env.VISION_MODEL || "gemini-3.7-flash";
const N = Number(process.env.FRAMES || 6);
const TMP = "prompts/_inspect";
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

execFileSync(ffmpegPath, ["-hide_banner", "-v", "error", "-y", "-i", video,
  "-vf", `fps=${N}/8,scale=540:-1`, `${TMP}/%02d.png`]);
const frames = fs.readdirSync(TMP).filter((f) => f.endsWith(".png")).sort().slice(0, N);

const SCHEMA = {
  type: "object",
  properties: {
    same_person: { type: "boolean", description: "Is the same individual present in every frame that contains a person, with the same face, hair and clothing?" },
    matches_reference: { type: "boolean", description: "Does that person match the supplied reference photograph?" },
    readable_text_in_frame: { type: "boolean", description: "Is there any readable lettering burned into the picture - captions, subtitles, signage, watermarks, on-screen words? A phone interface counts only if words on it are legible." },
    text_found: { type: "string", description: "Any lettering you could read, verbatim. Empty string if none." },
    hands_wrong: { type: "boolean", description: "Are any hands malformed - extra fingers, fused fingers, impossible joints?" },
    phone_visible: { type: "boolean", description: "Is a phone visible in at least one frame?" },
    look_holds: { type: "boolean", description: "Do lighting, colour grade and location stay consistent across the frames?" },
    worst_frame: { type: "integer", description: "1-indexed number of the weakest frame, or 0 if none stands out." },
    worst_problem: { type: "string", description: "One sentence on what is wrong with that frame, or empty if nothing is." },
  },
  required: ["same_person", "matches_reference", "readable_text_in_frame", "text_found", "hands_wrong", "phone_visible", "look_holds", "worst_frame", "worst_problem"],
};

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const parts = [
  { text: `These are ${frames.length} frames in order from one short vertical advertisement, followed by a reference photograph of the person who should appear in it. Judge only what you can see. Answer strictly against the schema.` },
  ...frames.map((f) => ({ inlineData: { mimeType: "image/png", data: fs.readFileSync(`${TMP}/${f}`).toString("base64") } })),
  { text: "Reference photograph of the intended person:" },
  { inlineData: { mimeType: "image/png", data: fs.readFileSync(reference).toString("base64") } },
];

const res = await ai.models.generateContent({
  model: MODEL, contents: [{ parts }],
  config: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0 },
});
const r = JSON.parse(res.text);

// A pass here means the frames carry no defect the model could see. It is not a promise
// the video is good, only that these specific failures are absent.
const checks = [
  ["same person throughout", r.same_person],
  ["matches the reference", r.matches_reference],
  ["no lettering in frame", !r.readable_text_in_frame, r.text_found],
  ["hands intact", !r.hands_wrong],
  ["phone present", r.phone_visible],
  ["look holds across frames", r.look_holds],
];
console.log(`${video}  (${frames.length} frames)\n`);
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(28)} ${!ok && detail ? detail : ""}`);
}
const failed = checks.filter(([, ok]) => !ok).length;
if (r.worst_frame) console.log(`\nweakest frame ${r.worst_frame}: ${r.worst_problem}`);
console.log(`\n${checks.length - failed}/${checks.length} passed`);

if (jsonIdx >= 0) fs.writeFileSync(args[jsonIdx + 1], JSON.stringify({ video, ...r, failed }, null, 2) + "\n");
process.exit(failed ? 1 : 0);
