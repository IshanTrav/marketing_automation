// Test harness for the prompt layer: system prompt + user prompt + response schema
// → one Gemini call → validate the returned JSON against our own rules.
// No media is generated here. Run: npm run test-prompt

import "dotenv/config";
import fs from "node:fs";
import { GoogleGenAI } from "@google/genai";
import { buildUserPrompt, validateCombo, USER_PROMPT_VERSION } from "./prompts/build-user-prompt.v1.js";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error("Missing GEMINI_API_KEY in .env"); process.exit(1); }

const SYSTEM_PROMPT_VERSION = "v4";
const MODEL = "gemini-3.7-flash";

const systemPrompt = fs
  .readFileSync("prompts/system-prompt.v4.md", "utf8")
  .replace(/^<!--[\s\S]*?-->\n*/, "");        // strip the file-header comment
const responseSchema = JSON.parse(fs.readFileSync("prompts/response-schema.v3.json", "utf8"));
delete responseSchema.$comment;
for (const k of Object.keys(responseSchema.properties)) delete responseSchema.properties[k].$comment;

const JOB = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], "utf8")) : null;

const dials = JOB?.dials ?? {
  shot_type: "medium_two_shot",
  time_of_day: "morning",
  camera_motion: "slow_push_in",
  weather: "clear_sky",
  palette: "warm_earth",
  film_look: "phone_shot_authentic",
  subject_focus: "planning_led",
  human_presence: "couple",
  story_arc: "problem_solution",
  pacing: "two_beat_medium",
  audio_bed: "dialogue_forward",
  dialogue: "two_person_exchange",
  hook_type: "bold_claim",       // number_stat is now blocked while facts is null
  caption_structure: "micro_listicle",
  copy_tone: "practical_utility",
  hashtag_mix: "budget_deal_heavy",
};

const topicText = JOB?.topic ?? "What 5 days in Bali actually costs from Bengaluru, end to end";
const facts = JOB?.facts ?? null;   // no verified data source yet

const userPrompt = buildUserPrompt({
  topic: topicText,
  conflict: JOB?.conflict,
  resolution: JOB?.resolution,
  format: "reel",
  ctaKeyword: "Comment TRAVAFA",
  dials,
  facts,
  targetDurationSeconds: JOB?.targetDurationSeconds ?? 20,
  demoSeconds: JOB?.demoSeconds ?? 5,
  ctaSeconds: JOB?.ctaSeconds ?? 3,
  scenePlanOverride: JOB?.scenePlanOverride ?? null,
  videoResolution: JOB?.videoResolution ?? "720p",
  recentPosts: JOB?.recentPosts ?? [
    { posted_on: "2026-08-19", primary_dials: { shot_type: "drone_aerial", time_of_day: "golden_hour", subject_focus: "place_led", human_presence: "none", story_arc: "reveal", audio_bed: "ambient_nature", hook_type: "direct_question" }, hook_line: "Ever wondered what Goa looks like before sunrise?" },
    { posted_on: "2026-08-20", primary_dials: { shot_type: "close_up_detail", time_of_day: "night_artificial", subject_focus: "food_led", human_presence: "hands_only", story_arc: "single_moment", audio_bed: "ambient_urban", hook_type: "relatable_confession" }, hook_line: "I flew to Bangkok mostly for the street food. No regrets." },
    { posted_on: "2026-08-21", primary_dials: { shot_type: "pov_handheld", time_of_day: "sunrise", subject_focus: "transit_led", human_presence: "solo_back_to_camera", story_arc: "journey_progression", audio_bed: "music_forward", hook_type: "pov_statement" }, hook_line: "POV: your 6am flight to Singapore is finally boarding." },
  ],
});

console.log(`model=${MODEL}  system=${SYSTEM_PROMPT_VERSION}  user=${USER_PROMPT_VERSION}`);
console.log("calling Gemini...\n");

const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3);
async function ai_call() {
  const ai = new GoogleGenAI({ apiKey });
  return ai.models.generateContent({
    model: MODEL,
    contents: userPrompt,
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: "application/json",
      responseSchema,
      temperature: 1.0,
    },
  });
}

let out, checks, failed, attempt;
for (attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
const res = await ai_call();
out = JSON.parse(res.text);

const allScenes = out.scenes.map((s) => s.scene_prompt).join("\n");
const totalDur = out.scenes.reduce((a, s) => a + s.duration_seconds, 0);
const demoSecs = JOB?.demoSeconds ?? 5;
const ctaSecs = JOB?.ctaSeconds ?? 3;
const targetDur = (JOB?.scenePlanOverride ?? []).reduce((a, d) => a + d, 0)
  || (JOB?.targetDurationSeconds ?? 20) - demoSecs - ctaSecs;


// ---- our own checks, independent of the model ----
const banned = ["beautiful", "stunning", "amazing", "breathtaking", "epic", "vibes"];
const firstLine = out.caption.split("\n")[0];
const sceneWords = out.scenes.map((s) => s.scene_prompt.trim().split(/\s+/).length);
const dialogueScenes = out.scenes.filter((s) => s.carries_dialogue).length;
const quoted = (allScenes.match(/"[^"]*"/g) || []).join(" ");
const spokenBrand = (quoted.match(/\bTravafa\b/gi) || []).length;
const badDur = out.scenes.filter((s) => ![4, 6, 8].includes(s.duration_seconds)).length;
const echoed = Object.entries(out.dials_used || {});
const mismatched = echoed.filter(([k, v]) => dials[k] !== v);
const missingEcho = Object.keys(dials).filter(k => !(k in (out.dials_used || {})));
const hitBanned = banned.filter(w => new RegExp(`\\b${w}\\b`, "i").test(allScenes));

const supplied = topicText + " " + JSON.stringify(facts ?? {});
const inventedNumbers = [...out.caption.matchAll(/(?:₹|\bRs\.?|\bINR)[ ]?[\d,]*\d(?:\.\d+)?k?|\b\d[\d,]*(?:\.\d+)?[ ]?(?:k\b|%|percent\b)/gi)]
  .map(m => m[0].trim())
  .filter(n => !supplied.replace(/[,\s]/g, "").includes(n.replace(/[^\d.]/g, "")));

checks = [
  ["scene prompts 60-150 words",       sceneWords.every((w) => w >= 60 && w <= 150), sceneWords.join(", ") + " words"],
  ["scene durations are 4, 6 or 8 (720p)",             badDur === 0,                              out.scenes.map((s) => s.duration_seconds + "s").join(" + ")],
  ["scenes sum to generated budget",   totalDur === targetDur,                    totalDur + "s of " + targetDur + "s generated"],
  ["problem lands in beat 2",         /\b(says|asks|replies|complains|wonders|frustrat\w*|frown\w*|confus\w*|annoy\w*|sigh\w*|exasperat\w*|puzzl\w*|disbelief|dismay|concern\w*|unimpressed|deflat\w*|winc\w*|shak\w+ (his|her|their) head|throws? up|gives? up|defeat\w*|tired|weary)\b/i
     .test(out.scenes[1]?.scene_prompt ?? ""), ""],
  ["exactly one scene per beat",       out.scenes.length === 3,                   out.scenes.length + " scenes"],
  ["no end card written as a scene",   !/\b(end card|logo|call to action|book your trips|closing title|final card)\b/i.test(allScenes), ""],
  ["brand named in final scene",       /\bTravafa\b/i.test(out.scenes[out.scenes.length - 1].scene_prompt), ""],
  ["brand spoken once, not more",      spokenBrand === 1,                         spokenBrand + "x spoken"],
  ["no crowd language",                !/\b(group of|crowd|four friends|three friends|everyone gathers|a group)\b/i.test(allScenes), ""],
  ["no banned adjectives",             hitBanned.length === 0,                    hitBanned.join(", ") || "clean"],
  ["no text-in-frame instruction",     !/\b(text|caption|subtitle|sign reading|words on screen)\b/i
     .test(allScenes.replace(/\b(no|without|zero|free of)\s+(visible\s+|readable\s+|on-screen\s+)?(text|caption|subtitle|signage|words)\w*/gi, "")), ""],
  ["audio described in every scene",   out.scenes.every((s) => /\b(audio|sound|ambien\w*|says|saying|voice|voiceover|music|silence|silent|speaks|replies|asks|tells|whispers|laughs|chatter|birdsong|hum|noise|audible)\b/i.test(s.scene_prompt)), ""],
  ["dials echoed complete",            missingEcho.length === 0,                  missingEcho.join(", ") || `all ${Object.keys(dials).length}`],
  ["dials echoed correct",             mismatched.length === 0,                   mismatched.map(([k,v])=>`${k}=${v}`).join(", ") || "match input"],
  ["hook line under 125 chars",        firstLine.length <= 125,                   `${firstLine.length} chars`],
  ["CTA keyword present",              out.caption.includes("Comment TRAVAFA"),   ""],
  ["no hashtags inside caption",       !out.caption.includes("#"),                ""],
  ["exactly 8 hashtags",               out.hashtags.length === 8,                 `${out.hashtags.length}`],
  ["hashtags lowercase, no #",         out.hashtags.every(h => h === h.toLowerCase() && !h.includes("#")), ""],
  ["hashtags unique",                  new Set(out.hashtags).size === out.hashtags.length, ""],
  // Fabricated pricing is the one failure a human reviewer is most likely to wave
  // through and the most damaging if published. Every number in the caption must
  // trace back to something we supplied.
  ["no invented numeric claims",       inventedNumbers.length === 0,              inventedNumbers.join(", ") || "all traceable"],
];

failed = checks.filter(([, ok]) => !ok).length;
  if (failed === 0 || attempt === MAX_ATTEMPTS) break;
  console.log(`attempt ${attempt}: ${failed} check(s) failed, regenerating...`);
}

function report() {
  console.log("─".repeat(72));
  out.scenes.forEach((sc, i) => {
    const tag = sc.carries_dialogue ? ", dialogue" : "";
    console.log("SCENE " + (i + 1) + "  (" + sc.duration_seconds + "s" + tag + ")\n");
    console.log(sc.scene_prompt + "\n");
  });
  console.log("\n" + "─".repeat(72));
  console.log("CAPTION\n");
  console.log(out.caption);
  console.log("\n" + "─".repeat(72));
  console.log("HASHTAGS: " + out.hashtags.map((h) => "#" + h).join(" "));
  console.log("ALT TEXT: " + out.alt_text);
  console.log("UNIQUENESS: " + out.uniqueness_rationale);
  console.log("DIAL CONFLICT: " + (out.dial_conflict || "(none)"));
}

report();
console.log("\n" + "─".repeat(72));
console.log(`CHECKS  (attempt ${attempt} of max ${MAX_ATTEMPTS})\n`);
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(32)} ${detail}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);

fs.writeFileSync(JOB?.out ?? "prompts/_last-test-output.json", JSON.stringify({ dials, output: out }, null, 2));
console.log("full output → " + (JOB?.out ?? "prompts/_last-test-output.json"));
