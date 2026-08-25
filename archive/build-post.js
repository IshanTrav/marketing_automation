// Turns a prompt-layer output file into a finished reel.
//
//   scene 1 → crop → last frame ─┐
//                                ├→ scene 2 generated from that frame → crop
//   concat (optionally with a real-app cutaway spliced in) → logo overlay
//     → composited end card → publishable mp4
//
// Chaining through the last frame is what keeps the people, wardrobe and location
// consistent across a cut. Veo 3.1 caps one generation at 8 seconds, so any post
// longer than that is necessarily a sequence.
//
// Usage: node build-post.js prompts/_out-c.json prompts/_final-c.mp4

import "dotenv/config";
import fs from "node:fs";
import { GoogleGenAI } from "@google/genai";
import { execFileSync } from "node:child_process";
import { cropTo9x16, lastFrame, concat, overlayLogo, appendEndCard, makeAppInsert } from "./video-lib.js";

const [, , src, out] = process.argv;
if (!src || !out) { console.error("usage: node build-post.js <prompt-output.json> <out.mp4>"); process.exit(1); }

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error("Missing GEMINI_API_KEY"); process.exit(1); }

const MODEL = "veo-3.1-fast-generate-preview";
const TMP = "prompts/_work";
fs.mkdirSync(TMP, { recursive: true });

const { output } = JSON.parse(fs.readFileSync(src, "utf8"));
const scenes = output.scenes;
const target = scenes.reduce((a, s) => a + s.duration_seconds, 0);

const ai = new GoogleGenAI({ apiKey });

async function generate(prompt, seconds, startImage) {
  const config = {
    aspectRatio: "9:16",
    resolution: "1080p",
    durationSeconds: seconds,
    negativePrompt:
      "on-screen text, captions, subtitles, watermarks, logos, brand names, " +
      "user interface elements, price tags, readable signage",
  };
  const req = { model: MODEL, prompt, config };
  if (startImage) {
    req.image = { imageBytes: fs.readFileSync(startImage).toString("base64"), mimeType: "image/png" };
  }
  let op = await ai.models.generateVideos(req);
  while (!op.done) {
    await new Promise((r) => setTimeout(r, 10000));
    op = await ai.operations.getVideosOperation({ operation: op });
  }
  if (!op.response?.generatedVideos?.length) {
    throw new Error("no video returned: " + JSON.stringify(op).slice(0, 600));
  }
  return op.response.generatedVideos[0].video;
}

const cleaned = [];
let handoff = null;

for (const [i, scene] of scenes.entries()) {
  const n = i + 1;
  console.log(`\nscene ${n}/${scenes.length}  ${scene.duration_seconds}s${scene.carries_dialogue ? "  (dialogue)" : ""}${handoff ? "  ← continues from previous frame" : ""}`);

  const clean = `${TMP}/clean-${n}.mp4`;
  // Scenes are expensive and later ones fail on their own. Reuse what already built.
  if (process.env.RESUME === "1" && fs.existsSync(clean)) {
    console.log("  reusing existing clip");
    cleaned.push(clean);
    if (n < scenes.length) handoff = lastFrame(clean, `${TMP}/handoff-${n}.png`);
    continue;
  }

  // Generation fails transiently often enough - including RAI filter hits - that a
  // single attempt is not enough.
  let video;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { video = await generate(scene.scene_prompt, scene.duration_seconds, handoff); break; }
    catch (e) {
      console.log(`  attempt ${attempt} failed: ${String(e.message).slice(0, 120)}`);
      if (attempt === 3) throw e;
      // Without a wait, three retries all land inside the same DNS or rate-limit
      // window and burn the budget without ever hitting a healthy moment.
      const wait = 5000 * 2 ** (attempt - 1);
      console.log(`  retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  const raw = `${TMP}/raw-${n}.mp4`;
  await ai.files.download({ file: video, downloadPath: raw });

  const crop = cropTo9x16(raw, clean);
  console.log(`  crop: ${crop ?? "none needed"}`);
  cleaned.push(clean);

  if (n < scenes.length) handoff = lastFrame(clean, `${TMP}/handoff-${n}.png`);
}

const watermarked = cleaned.map((clip, i) => {
  const marked = `${TMP}/marked-${i + 1}.mp4`;
  overlayLogo(clip, marked);
  return marked;
});

// A cutaway of the real interface, cut in between generated scenes. The generated
// footage can only get the colour of the screen right; this is where the actual product
// is shown. APP_INSERT_AFTER=2 places it after the second scene.
const insertAfter = Number(process.env.APP_INSERT_AFTER || 0);
let timeline = watermarked;
let insertSeconds = 0;
if (insertAfter > 0 && insertAfter <= cleaned.length) {
  insertSeconds = Number(process.env.APP_INSERT_SECONDS || 2);
  const shot = process.env.APP_INSERT_IMAGE || "assets/app/flight-search.png";
  const clip = makeAppInsert(shot, `${TMP}/app-insert.mp4`, {
    seconds: insertSeconds,
    mode: process.env.APP_INSERT_MODE || "scroll",
  });
  timeline = [...watermarked.slice(0, insertAfter), clip, ...watermarked.slice(insertAfter)];
  console.log(`\napp cutaway: ${shot} (${insertSeconds}s) after scene ${insertAfter}`);
}

const joined = `${TMP}/joined.mp4`;
concat(timeline, joined, target + insertSeconds);

// The card closes on the brand and the call to action - the one place a logo and a
// line of copy can appear exactly as designed, because neither is generated.
const CARD_SECONDS = Number(process.env.END_CARD_SECONDS || 3);
const cardBg = lastFrame(joined, `${TMP}/card-bg.png`);
const cardPng = `${TMP}/endcard.png`;
execFileSync("python3", ["make-endcard.py", cardBg, "assets/travafa-logo-white.png", cardPng,
  process.env.END_CARD_TEXT || "Book your trips now"], { stdio: "inherit" });
appendEndCard(joined, cardPng, CARD_SECONDS, out);

const total = target + insertSeconds + CARD_SECONDS;
console.log(`\n${scenes.length} scenes ${target}s${insertSeconds ? ` + ${insertSeconds}s app cutaway` : ""} + ${CARD_SECONDS}s end card = ${total}s → ${out} (${(fs.statSync(out).size / 1e6).toFixed(2)} MB)`);
