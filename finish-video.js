// Post-generation step: strip the letterbox Veo bakes in, restore true 9:16, and
// composite the Travafa logo into the top-left safe zone.
//
// The logo is deliberately NOT part of the media prompt. Video models cannot render
// a specific logo accurately - they produce a plausible-looking fake, which is worse
// than no logo at all. Compositing is exact and free.
//
// Usage: node finish-video.js <in.mp4> <out.mp4>

import { execFileSync, spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import fs from "node:fs";

const [, , input, output] = process.argv;
if (!input || !output) { console.error("usage: node finish-video.js <in.mp4> <out.mp4>"); process.exit(1); }

// The full-colour logo has a dark wordmark, which disappears against pale footage.
// The white variant with a shadow reads on both dark and light backgrounds, which is
// what unpredictable generated video needs. LOGO_VARIANT=colour to compare.
const LOGO = process.env.LOGO_VARIANT === "colour"
  ? "assets/travafa-logo.png"
  : "assets/travafa-logo-white.png";
const TARGET_W = 1080, TARGET_H = 1920;
const LOGO_W = 250;        // ~23% of frame width
const MARGIN = 48;
const SHADOW_OFFSET = 3;

const ff = (args) => execFileSync(ffmpegPath, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// --- 1. find the real picture area. Veo returns 9:16 with black bars baked in,
//        and the amount varies between generations, so measure every clip.
// cropdetect writes to stderr on success, so spawnSync is needed - execFileSync only
// surfaces stderr when the process fails.
const det = spawnSync(ffmpegPath, ["-hide_banner", "-v", "info", "-i", input,
  "-vf", "cropdetect=limit=24:round=2:reset=0", "-frames:v", "120", "-f", "null", "-"],
  { encoding: "utf8" });
const detect = (det.stderr || "") + (det.stdout || "");
const crops = [...detect.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].map((m) => m[0]);
const crop = crops.length ? crops[crops.length - 1] : null;

console.log(`input: ${input}`);
console.log(`cropdetect: ${crop ?? "no letterbox found"}`);

// --- 2. crop away the bars, then fill 1080x1920 without stretching
const cropFilter = crop ? `${crop},` : "";
const base = `[0:v]${cropFilter}scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=increase,crop=${TARGET_W}:${TARGET_H}[base]`;

// --- 3. logo, plus a soft dark shadow so a dark wordmark stays legible on dark footage
const logoChain =
  `[1:v]scale=${LOGO_W}:-1[lg];` +
  `[lg]split=2[l1][l2];` +
  `[l1]colorchannelmixer=rr=0:rg=0:rb=0:gr=0:gg=0:gb=0:br=0:bg=0:bb=0,boxblur=5:1[sh]`;

const filter =
  `${base};${logoChain};` +
  `[base][sh]overlay=${MARGIN + SHADOW_OFFSET}:${MARGIN + SHADOW_OFFSET}[withshadow];` +
  `[withshadow][l2]overlay=${MARGIN}:${MARGIN}[v]`;

ff([
  "-hide_banner", "-v", "error", "-y",
  "-i", input, "-i", LOGO,
  "-filter_complex", filter,
  "-map", "[v]", "-map", "0:a?",
  "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "192k",
  "-movflags", "+faststart",
  output,
]);

console.log(`output: ${output} (${(fs.statSync(output).size / 1e6).toFixed(2)} MB)`);
