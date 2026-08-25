// Assembles a reel from a beat timeline.
//
//   generated beats   produced by Veo at 720p, cropped, then TRIMMED to their beat length
//   demo beat         real app footage: full frame, an inset, or keyed onto a phone
//   cta beat          a designed card
//   over everything   composited caption text, the logo, and a TTS narration track
//
// Clips are asked for longer than they are used. Veo's shortest generation is four
// seconds; a hook that holds attention is two and a half. Trimming is free, so the edit
// rhythm is chosen here rather than dictated by the model's minimum.
//
// Usage: node build-reel-v2.js <beats-out.json> <out.mp4> [references.json]

import "dotenv/config";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { GoogleGenAI } from "@google/genai";
import { cropTo9x16, lastFrame, concat, overlayLogo, ff, TARGET_W, TARGET_H } from "./video-lib.js";
import { demoCutaway, demoPip, demoScreenKeyed } from "./demo-composite.js";

const [, , src, out, manifestArg] = process.argv;
if (!src || !out) { console.error("usage: node build-reel-v2.js <beats-out.json> <out.mp4> [references.json]"); process.exit(1); }

// Veo reference images are a Veo 3.1 capability. Override only with a model/version that
// supports them; the standard preview model is the documented safe default.
const MODEL = process.env.VEO_MODEL || "veo-3.1-generate-preview";
const TMP = process.env.WORK_DIR || "prompts/_build";
fs.mkdirSync(TMP, { recursive: true });

const { dials, output } = JSON.parse(fs.readFileSync(src, "utf8"));
const beats = output.beats;
const manifestPath = manifestArg || process.env.REFS_MANIFEST;
const refsManifest = manifestPath ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
const referencePaths = refsManifest
  ? [refsManifest.images.character, refsManifest.images.hero_phone, refsManifest.images.environment]
  : [];
if (referencePaths.length > 3) throw new Error("Veo accepts at most three reference images");
for (const ref of referencePaths) {
  if (!fs.existsSync(ref)) throw new Error(`Missing Veo reference image: ${ref}`);
}
const asset = (file) => ({
  image: {
    imageBytes: fs.readFileSync(file).toString("base64"),
    mimeType: file.toLowerCase().endsWith(".jpg") || file.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : "image/png",
  },
  referenceType: "ASSET",
});
const veoReferences = referencePaths.map(asset);
const style = process.env.DEMO_STYLE || dials.demo_style || "cutaway";
const RECORDING = process.env.RECORDING || "assets/app/rec-search-results.mp4";
// A whole phone screen shrunk into an inset is unreadable, so an inset shows only the
// part worth reading. A full-frame cutaway can afford the whole thing.
const REGION = style === "cutaway" ? { x: 0, y: 0.10, w: 1, h: 0.72 }
                                   : { x: 0.03, y: 0.30, w: 0.94, h: 0.40 };

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function generate(prompt, seconds, startImage) {
  const req = { model: MODEL, prompt, config: {
    aspectRatio: "9:16", resolution: "720p", durationSeconds: seconds,
    ...(veoReferences.length ? { referenceImages: veoReferences } : {}),
    // Captions and marketing overlays are added in post. The Travafa interface and brand
    // are deliberately allowed because the reference pack is now the product proof.
    negativePrompt: "subtitles, closed captions, watermarks, unrelated logos, unrelated " +
      "brand names, floating marketing copy, readable background signage",
  }};
  if (startImage) req.image = { imageBytes: fs.readFileSync(startImage).toString("base64"), mimeType: "image/png" };
  let op = await ai.models.generateVideos(req);
  while (!op.done) {
    await new Promise((r) => setTimeout(r, 10000));
    op = await ai.operations.getVideosOperation({ operation: op });
  }
  if (!op.response?.generatedVideos?.length) throw new Error("no video: " + JSON.stringify(op).slice(0, 300));
  return op.response.generatedVideos[0].video;
}

/** Keeps the middle of a clip: the model puts the beat's best moment there, and the
 *  first and last frames of a generation are the least reliable. */
function trimMiddle(input, output, useSeconds, clipSeconds) {
  const start = Math.max(0, (clipSeconds - useSeconds) / 2);
  ff(["-ss", String(start), "-i", input, "-t", String(useSeconds),
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", output]);
  return output;
}

/** One beat's caption, drawn in Python and laid over the clip for its whole length. */
function addText(input, text, output) {
  if (!text?.trim()) { fs.copyFileSync(input, output); return output; }
  const png = `${TMP}/text-${Buffer.from(text).toString("hex").slice(0, 12)}.png`;
  execFileSync("python3", ["render_text.py", "beat", png, text], { stdio: "pipe" });
  ff(["-i", input, "-i", png, "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto,format=yuv420p[v]",
      "-map", "[v]", "-map", "0:a?", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", output]);
  return output;
}

const pieces = [];
let handoff = null;

console.log(veoReferences.length
  ? `Veo references: ${referencePaths.map((file) => file.split("/").pop()).join(", ")}`
  : "Veo references: none (pass references.json as argument or REFS_MANIFEST)");

for (const [i, beat] of beats.entries()) {
  const n = i + 1;
  const tag = `beat ${n} ${beat.id}`.padEnd(18);
  let clip = `${TMP}/beat-${beat.id}.mp4`;

  if (beat.source === "generated") {
    const cut = `${TMP}/cut-${beat.id}.mp4`;
    if (!(fs.existsSync(cut) && process.env.RESUME === "1")) {
      console.log(`${tag} generate ${beat.generate_seconds}s → use ${beat.use_seconds}s${handoff ? "  ← continues" : ""}`);
      let video;
      for (let a = 1; a <= 3; a++) {
        try { video = await generate(beat.scene_prompt, beat.generate_seconds, handoff); break; }
        catch (e) {
          console.log(`   attempt ${a}: ${String(e.message).slice(0, 90)}`);
          if (a === 3) throw e;
          await new Promise((r) => setTimeout(r, 5000 * 2 ** (a - 1)));
        }
      }
      const raw = `${TMP}/raw-${beat.id}.mp4`;
      await ai.files.download({ file: video, downloadPath: raw });
      const clean = `${TMP}/clean-${beat.id}.mp4`;
      cropTo9x16(raw, clean);
      trimMiddle(clean, cut, beat.use_seconds, beat.generate_seconds);
    } else {
      console.log(`${tag} reusing`);
    }
    // Beats 1-3 share a place and chain through the previous frame. The payoff is
    // somewhere else entirely, so it must start clean - chaining into it would drag the
    // living room to the airport.
    handoff = (beat.id === "hook" || beat.id === "problem") ? lastFrame(cut, `${TMP}/handoff.png`) : null;

    if (beat.id === "demo" && style !== "cutaway") {
      const withApp = `${TMP}/demo-${style}.mp4`;
      if (style === "pip_overlay") {
        demoPip(cut, RECORDING, withApp, { seconds: beat.use_seconds, startAt: 0, side: "right", widthPct: 0.40, region: REGION });
      } else {
        const rect = JSON.parse(process.env.SCREEN_RECT || '{"x":566,"y":840,"w":220,"h":460}');
        demoScreenKeyed(cut, RECORDING, withApp, {
          seconds: beat.use_seconds, startAt: 0, screenRect: rect,
          keyColour: process.env.KEY_COLOUR || null, similarity: 0.40, blend: 0.18,
        });
      }
      fs.copyFileSync(withApp, cut);
    }
    const marked = `${TMP}/marked-${beat.id}.mp4`;
    overlayLogo(cut, marked);
    addText(marked, beat.on_screen_text, clip);

  } else if (beat.source === "app_recording") {
    handoff = null;
    console.log(`${tag} app recording ${beat.use_seconds}s`);
    const shot = demoCutaway(RECORDING, `${TMP}/app-${beat.id}.mp4`, { seconds: beat.use_seconds, region: REGION });
    // No watermark here: it lands on the app's own header and is redundant on a shot
    // that is already unmistakably the product.
    addText(shot, beat.on_screen_text, clip);

  } else {
    handoff = null;
    console.log(`${tag} end card ${beat.use_seconds}s`);
    const bgSource = pieces[pieces.length - 1];
    const bg = lastFrame(bgSource, `${TMP}/card-bg.png`);
    const png = `${TMP}/card.png`;
    execFileSync("python3", ["render_text.py", "card", bg, "assets/travafa-logo.png", png,
      beat.on_screen_text || "Find your next flight for less",
      process.env.CTA_BUTTON || "Try Travafa"], { stdio: "inherit" });
    ff(["-loop", "1", "-t", String(beat.use_seconds), "-i", png,
        "-f", "lavfi", "-t", String(beat.use_seconds), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-vf", `scale=${TARGET_W}:${TARGET_H},format=yuv420p`, "-r", "24",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "192k", "-shortest", clip]);
  }
  pieces.push(clip);
}

const body = `${TMP}/body.mp4`;
concat(pieces, body);

// The narration sits over everything. The clips' own ambience is ducked well under it -
// generated room tone is texture, the words are the message.
const vo = `${TMP}/vo.wav`;
execFileSync("node", ["make-voiceover.js", src, vo], { stdio: "inherit" });
ff(["-i", body, "-i", vo,
    "-filter_complex", "[0:a]volume=0.22[bed];[1:a]volume=1.25[vo];[bed][vo]amix=inputs=2:normalize=0:duration=first[a]",
    "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out]);

const total = beats.reduce((a, b) => a + b.use_seconds, 0);
console.log(`\n${style}: ${beats.length} beats = ${total}s → ${out} (${(fs.statSync(out).size / 1e6).toFixed(2)} MB)`);
