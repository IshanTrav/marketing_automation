// Shared ffmpeg helpers for turning raw Veo output into a publishable reel.
//
// Veo bakes a letterbox into some generations and not others, and the amount varies,
// so every clip is measured rather than cropped by a fixed rule.

import { execFileSync, spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import fs from "node:fs";

export const TARGET_W = 1080, TARGET_H = 1920;

export const ff = (args) =>
  execFileSync(ffmpegPath, ["-hide_banner", "-v", "error", "-y", ...args], { encoding: "utf8" });

/** Measures the real picture area, ignoring black bars Veo padded in. */
export function detectCrop(input) {
  const det = spawnSync(ffmpegPath, ["-hide_banner", "-v", "info", "-i", input,
    "-vf", "cropdetect=limit=24:round=2:reset=0", "-frames:v", "120", "-f", "null", "-"],
    { encoding: "utf8" });
  const out = (det.stderr || "") + (det.stdout || "");
  const hits = [...out.matchAll(/crop=\d+:\d+:\d+:\d+/g)].map((m) => m[0]);
  return hits.length ? hits[hits.length - 1] : null;
}

/** Removes the letterbox and fills a true 1080x1920 without stretching. */
export function cropTo9x16(input, output) {
  const crop = detectCrop(input);
  const chain = (crop ? `${crop},` : "") +
    `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=increase,crop=${TARGET_W}:${TARGET_H}`;
  ff(["-i", input, "-vf", chain, "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", output]);
  return crop;
}

/**
 * Keeps only the last `seconds` of a clip. Uses -sseof so no seek-then-trim
 * mismatch — ffmpeg rewinds exactly N seconds from the end.
 */
export function trimToLast(input, output, seconds) {
  ff(["-sseof", `-${seconds}`, "-i", input, "-t", String(seconds),
      "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", output]);
  return output;
}

/** Grabs the final frame, used as the opening frame of the next scene. */
export function lastFrame(input, output) {
  ff(["-sseof", "-0.2", "-i", input, "-frames:v", "1", "-q:v", "2", output]);
  return output;
}

/** Joins scenes end to end. Re-encodes because the scenes are separate generations. */
export function concat(inputs, output, trimTo = null) {
  const args = inputs.flatMap((f) => ["-i", f]);
  const n = inputs.length;
  const graph = inputs.map((_, i) => `[${i}:v][${i}:a]`).join("") + `concat=n=${n}:v=1:a=1[v][a]`;
  ff([...args, "-filter_complex", graph, "-map", "[v]", "-map", "[a]",
      ...(trimTo ? ["-t", String(trimTo)] : []),
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output]);
}

/**
 * Composites the logo into the top-left safe zone the system prompt reserves.
 * The white variant plus a soft shadow is the only treatment that survives both
 * dark night footage and pale daylight.
 */
export function overlayLogo(input, output, { variant = "white", width = 250, margin = 48, shadow = 3 } = {}) {
  const logo = variant === "colour" ? "assets/travafa-logo.png" : "assets/travafa-logo-white.png";
  if (!fs.existsSync(logo)) throw new Error(`missing logo: ${logo}`);
  const filter =
    `[1:v]scale=${width}:-1[lg];[lg]split=2[l1][l2];` +
    `[l1]colorchannelmixer=rr=0:rg=0:rb=0:gr=0:gg=0:gb=0:br=0:bg=0:bb=0,boxblur=5:1[sh];` +
    `[0:v][sh]overlay=${margin + shadow}:${margin + shadow}[s];` +
    `[s][l2]overlay=${margin}:${margin}[v]`;
  ff(["-i", input, "-i", logo, "-filter_complex", filter, "-map", "[v]", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output]);
}

/**
 * Composites a transparent PNG onto a clip from `startAt` seconds to the end, instead
 * of appending it as a separate clip. This is how the CTA lands on the final part's own
 * footage and the video ends on the shot, with no card spliced on afterwards.
 */
export function overlayTimedPng(input, pngPath, output, startAt) {
  const filter = `[0:v][1:v]overlay=0:0:enable='gte(t,${startAt})':format=auto,format=yuv420p[v]`;
  ff(["-i", input, "-i", pngPath, "-filter_complex", filter, "-map", "[v]", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output]);
}

/**
 * Appends the composited closing card. The card is a still, so it gets a silent audio
 * track to match the video's stream layout - concat refuses mismatched inputs.
 */
export function appendEndCard(video, cardPng, seconds, output) {
  const card = `${output}.card.mp4`;
  ff(["-loop", "1", "-t", String(seconds), "-i", cardPng,
      "-f", "lavfi", "-t", String(seconds), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-vf", `scale=${TARGET_W}:${TARGET_H},format=yuv420p`,
      "-r", "24", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
      "-c:a", "aac", "-b:a", "192k", "-shortest", card]);
  concat([video, card], output);
  fs.unlinkSync(card);
}

/**
 * Builds a cutaway shot of the real app, to be cut in between generated scenes.
 *
 * This is the answer to "the app on screen must actually look like Travafa". Trying to
 * composite the UI onto the phone inside a generated shot needs planar tracking of a
 * surface that moves, tilts and goes out of focus. A cutaway sidesteps all of it: the
 * interface is shown for real, in its own shot, exactly as designed - which is how
 * product beats are cut in real advertising anyway.
 *
 * The OS status bar and gesture bar are cropped away so the shot reads as the product,
 * not as someone's screen recording.
 */
export function makeAppInsert(screenshot, output, { seconds = 2, mode = "scroll" } = {}) {
  const STATUS_BAR = 0.045, GESTURE_BAR = 0.03;   // fractions of the screenshot height
  const chain = [
    `crop=iw:ih*${(1 - STATUS_BAR - GESTURE_BAR).toFixed(3)}:0:ih*${STATUS_BAR}`,
    `scale=${TARGET_W}:-1`,
    mode === "scroll"
      // Drifts down the screen at a readable pace, the way a thumb would.
      ? `crop=${TARGET_W}:${TARGET_H}:0:'(ih-${TARGET_H})*min(t/${seconds},1)'`
      // Holds near the top and eases in slightly, for a single-beat product shot.
      : `scale=${Math.round(TARGET_W * 1.06)}:-1,crop=${TARGET_W}:${TARGET_H}:(iw-${TARGET_W})/2:0`,
    "format=yuv420p",
  ].join(",");

  ff(["-loop", "1", "-t", String(seconds), "-i", screenshot,
      "-f", "lavfi", "-t", String(seconds), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-vf", chain, "-r", "24",
      "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-c:a", "aac", "-b:a", "192k", "-shortest", output]);
  return output;
}
