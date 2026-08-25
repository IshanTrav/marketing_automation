// Strips the skeleton-loading stretch out of an app screen recording.
//
// A demo beat is five seconds. A recording where seven of its nineteen seconds are
// placeholder blocks cannot spare them - and loading states are the one thing an ad
// should never show. Cutting straight from the tap to the result is also how the
// product actually feels to use.
//
// Loading frames are found by measuring colour, not by hand: a skeleton screen has
// essentially no saturated pixels, while a results screen is full of airline logos.
//
// Usage: node clean-recording.js <in.mp4> <out.mp4> [keepUntil] [resumeAt]
//        omit the timings to have them detected

import { execFileSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ff = (args) => execFileSync(ffmpegPath, ["-hide_banner", "-v", "error", "-y", ...args], { encoding: "utf8" });

/** Returns [keepUntil, resumeAt] in seconds, or null if nothing looks like loading. */
export function findLoadingRun(input, fps = 5) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));
  ff(["-i", input, "-vf", `fps=${fps},scale=180:-1`, path.join(dir, "%04d.png")]);
  const script = `
from PIL import Image
import glob, sys, json
vals = []
for f in sorted(glob.glob(sys.argv[1] + "/*.png")):
    im = Image.open(f).convert("RGB")
    w, h = im.size
    im = im.crop((0, int(h*0.16), w, int(h*0.95)))
    px = list(im.getdata())
    sat = sum(1 for r,g,b in px if max(r,g,b) and (max(r,g,b)-min(r,g,b))/max(r,g,b) > 0.45 and max(r,g,b) > 70)
    vals.append(sat/len(px)*100)
dead = [i for i,v in enumerate(vals) if v < 0.02]
print(json.dumps([dead[0], dead[-1]] if dead else None))
`;
  const out = execFileSync("python3", ["-c", script, dir], { encoding: "utf8" }).trim();
  fs.rmSync(dir, { recursive: true, force: true });
  const run = JSON.parse(out);
  if (!run) return null;
  const [start, end] = run;
  return [(start - 1) / fps, (end + 1) / fps];
}

export function cleanRecording(input, output, keepUntil, resumeAt) {
  if (keepUntil == null) {
    const found = findLoadingRun(input);
    if (!found) { console.log("no loading run found; copying through"); [keepUntil, resumeAt] = [null, null]; }
    else [keepUntil, resumeAt] = found;
  }

  // Audio is dropped: a screen recorder captures room noise, and every consumer of
  // these clips supplies its own track. Re-encoded to H.264 because the phone records
  // HEVC, which the rest of the pipeline does not expect.
  const common = ["-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];

  if (keepUntil == null) { ff(["-i", input, ...common, output]); return; }

  ff(["-i", input,
      "-filter_complex",
      `[0:v]trim=0:${keepUntil},setpts=PTS-STARTPTS[a];` +
      `[0:v]trim=start=${resumeAt},setpts=PTS-STARTPTS[b];` +
      `[a][b]concat=n=2:v=1:a=0[v]`,
      "-map", "[v]", ...common, output]);
}

const [, , input, output, keepUntil, resumeAt] = process.argv;
if (input && output) {
  cleanRecording(input, output, keepUntil ? Number(keepUntil) : null, resumeAt ? Number(resumeAt) : null);
  const dur = (f) => {
    const r = execFileSync(ffmpegPath, ["-hide_banner", "-i", f], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).toString();
    return r;
  };
  console.log(`${input} → ${output} (${(fs.statSync(output).size / 1e6).toFixed(2)} MB)`);
}
