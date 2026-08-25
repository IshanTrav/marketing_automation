// The three ways real app footage reaches the screen. The interface is never generated -
// a video model cannot draw a UI, and a convincing fake is worse for a brand than
// showing nothing. Which one a post uses is the `demo_style` dial.
//
//   cutaway      full-frame shot of the app, cut between generated scenes
//   pip_overlay  app plays as an inset while the generated scene keeps running
//   screen_keyed app keyed onto a phone held still in the generated shot
//
// All three take the same input: a real screen recording (or a still, as a fallback).

import { execFileSync, spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import fs from "node:fs";
import { TARGET_W, TARGET_H, ff } from "./video-lib.js";

const isStill = (p) => /\.(png|jpe?g|webp)$/i.test(p);

/** Reads a recording's dimensions so crops can be expressed as fractions. */
export function probeSize(file) {
  const r = spawnSync(ffmpegPath, ["-hide_banner", "-i", file], { encoding: "utf8" });
  const m = ((r.stderr || "") + (r.stdout || "")).match(/, (\d{2,5})x(\d{2,5})/);
  if (!m) throw new Error(`could not read dimensions of ${file}`);
  return { w: Number(m[1]), h: Number(m[2]) };
}

/**
 * Crops a recording to the part worth showing. A whole phone screen shrunk into a
 * corner is unreadable; a cropped region of it is not. `region` is in fractions of
 * the source: {x, y, w, h}.
 */
function regionChain(src, region) {
  if (!region) return "";
  const { w, h } = probeSize(src);
  const rx = Math.round(w * (region.x ?? 0));
  const ry = Math.round(h * (region.y ?? 0));
  const rw = Math.round(w * (region.w ?? 1)) & ~1;
  const rh = Math.round(h * (region.h ?? 1)) & ~1;
  return `crop=${rw}:${rh}:${rx}:${ry},`;
}

/** Shared front end: a recording or a still becomes a clip of a known length. */
function sourceArgs(src, seconds) {
  return isStill(src)
    ? ["-loop", "1", "-t", String(seconds), "-i", src]
    : ["-stream_loop", "-1", "-t", String(seconds), "-i", src];
}

// ── 1. cutaway ──────────────────────────────────────────────────────────────
export function demoCutaway(src, output, { seconds = 5, region = null } = {}) {
  const chain =
    regionChain(src, region) +
    `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=increase,` +
    `crop=${TARGET_W}:${TARGET_H},format=yuv420p`;
  ff([...sourceArgs(src, seconds),
      "-f", "lavfi", "-t", String(seconds), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-vf", chain, "-r", "24", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-c:a", "aac", "-b:a", "192k", "-shortest", output]);
  return output;
}

// ── 2. picture in picture ───────────────────────────────────────────────────
/**
 * Keeps the generated scene running and drops the app in beside it, so the story does
 * not stop for the demo. The generated frame must have been composed to leave this side
 * quiet - that is what the `pip_overlay` rule in the system prompt is for.
 */
export function demoPip(scene, src, output, {
  seconds = 5, startAt = 0, side = "right", widthPct = 0.42, region = null, margin = 56,
  // Faces sit in the middle of a vertical frame, so a centred inset lands on one. The
  // lower third is the quiet part of almost any two-shot, and it is also roughly where
  // a real phone would be held.
  verticalPct = 0.56,
} = {}) {
  const pipW = Math.round(TARGET_W * widthPct) & ~1;
  // The plate has to match the inset, not the frame. Sized to full height it reads as a
  // vertical band cutting the shot in half rather than as a panel sitting on top of it.
  const src0 = probeSize(src);
  const srcW = Math.round(src0.w * (region?.w ?? 1));
  const srcH = Math.round(src0.h * (region?.h ?? 1));
  const pipH = Math.round((srcH * pipW) / srcW) & ~1;
  const pad = 14;
  const x = side === "right" ? TARGET_W - pipW - margin : margin;
  const y = Math.min(Math.round(TARGET_H * verticalPct), TARGET_H - pipH - margin);
  const end = startAt + seconds;

  const filter =
    `[1:v]${regionChain(src, region)}scale=${pipW}:-2,setpts=PTS-STARTPTS[pip];` +
    // A soft dark plate behind the inset so it reads as a deliberate element rather
    // than a hole punched in the shot.
    `color=c=black@0.55:s=${pipW + pad * 2}x${pipH + pad * 2}:d=${seconds}[plate];` +
    `[0:v][plate]overlay=${x - pad}:${y - pad}:enable='between(t,${startAt},${end})':format=auto[bg];` +
    `[bg][pip]overlay=${x}:${y}:enable='between(t,${startAt},${end})':format=auto,format=yuv420p[v]`;

  ff(["-i", scene, ...sourceArgs(src, seconds),
      "-filter_complex", filter, "-map", "[v]", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", output]);
  return output;
}

// ── 3. screen keyed onto the phone ──────────────────────────────────────────
/**
 * Replaces a plain phone screen in generated footage with the real recording.
 *
 * `screenRect` is where the screen sits in the frame, in pixels: {x, y, w, h}. It is
 * fixed, which is why the system prompt requires the phone to be held still - a moving
 * phone would need per-frame tracking, which is a different order of problem.
 *
 * `keyColour` null means the screen is matted by position alone. Give it a colour
 * (e.g. "0x00b140") when the generated screen is a solid green panel, and the key will
 * cut around fingers crossing in front of it.
 */
export function demoScreenKeyed(scene, src, output, {
  seconds = 5, startAt = 0, screenRect, screenRectEnd = null,
  keyColour = null, similarity = 0.20, blend = 0.06,
} = {}) {
  if (!screenRect) throw new Error("screenRect is required: {x, y, w, h} in pixels");
  const a = screenRect;
  const b = screenRectEnd ?? screenRect;
  const end = startAt + seconds;
  const w = Math.max(a.w, b.w) & ~1;
  const h = Math.max(a.h, b.h) & ~1;

  // A hand-held phone drifts even when the shot is described as still. Position is
  // interpolated across the window rather than fixed; size is left alone because the
  // measured change over a usable window is a few percent, well under what the key hides.
  const ramp = `min(max((t-${startAt})/${seconds},0),1)`;
  const xExpr = `${a.x}+(${b.x - a.x})*(${ramp})`;
  const yExpr = `${a.y}+(${b.y - a.y})*(${ramp})`;

  const app = `[1:v]scale=${w}:${h},setpts=PTS-STARTPTS[app];`;
  const base = keyColour
    // App underneath, the keyed scene back on top. Anything the app spills past the
    // screen edge is covered by the scene itself, so a slightly generous rect is safe.
    ? `[0:v]split=2[raw][key];` +
      `[key]chromakey=${keyColour}:${similarity}:${blend},despill=type=green[holes];` +
      `[raw][app]overlay=x='${xExpr}':y='${yExpr}':enable='between(t,${startAt},${end})':format=auto[under];` +
      `[under][holes]overlay=0:0:format=auto,format=yuv420p[v]`
    : `[0:v][app]overlay=x='${xExpr}':y='${yExpr}':enable='between(t,${startAt},${end})':format=auto,format=yuv420p[v]`;

  ff(["-i", scene, ...sourceArgs(src, seconds),
      "-filter_complex", app + base, "-map", "[v]", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", output]);
  return output;
}
