// Exercises the beat-based prompt layer: system prompt v5 + schema v4 + builder v2.
// One Gemini call, then validation against our own rules rather than the model's word.
//
// Usage: node test-beats.js prompts/_job-x.json

import "dotenv/config";
import fs from "node:fs";
import { GoogleGenAI } from "@google/genai";
import { buildUserPrompt, beatPlan, USER_PROMPT_VERSION } from "./prompts/build-user-prompt.v2.js";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error("Missing GEMINI_API_KEY"); process.exit(1); }

const SYSTEM_PROMPT_VERSION = "v5";
const MODEL = "gemini-3.7-flash";
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3);

const JOB = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const systemPrompt = fs.readFileSync("prompts/system-prompt.v5.md", "utf8").replace(/^<!--[\s\S]*?-->\n*/, "");
const schema = JSON.parse(fs.readFileSync("prompts/response-schema.v4.json", "utf8"));
delete schema.$comment;
for (const k of Object.keys(schema.properties)) delete schema.properties[k].$comment;

const plan = beatPlan({ videoResolution: JOB.videoResolution ?? "720p", overrides: JOB.beatOverrides ?? {} });
const userPrompt = buildUserPrompt({ ...JOB, ctaKeyword: JOB.ctaKeyword ?? "Comment TRAVAFA" });

console.log(`model=${MODEL}  system=${SYSTEM_PROMPT_VERSION}  user=${USER_PROMPT_VERSION}`);

const ai = new GoogleGenAI({ apiKey });
let out, checks, failed, attempt;

for (attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const res = await ai.models.generateContent({
    model: MODEL, contents: userPrompt,
    config: { systemInstruction: systemPrompt, responseMimeType: "application/json", responseSchema: schema, temperature: 1.0 },
  });
  out = JSON.parse(res.text);

  const beats = out.beats ?? [];
  const gen = beats.filter((b) => b.source === "generated");
  const words = (s) => (s || "").trim().split(/\s+/).filter(Boolean).length;
  const allScenes = gen.map((b) => b.scene_prompt || "").join("\n");
  const vo = beats.map((b) => b.voiceover || "").join(" ");
  const quoted = (allScenes.match(/"[^"]*"/g) || []).join(" ");

  const overBudget = beats.filter((b) => {
    const budget = Math.round(b.use_seconds * 2.5);
    return words(b.voiceover) > budget + 2;   // two words of slack
  });
  const longText = beats.filter((b) => words(b.on_screen_text) > 7);
  const emptyText = beats.filter((b) => !(b.on_screen_text || "").trim());
  const planMismatch = beats.filter((b, i) => plan[i] && (b.id !== plan[i].id || b.source !== plan[i].source || b.use_seconds !== plan[i].use));
  const strayScene = beats.filter((b) => b.source !== "generated" && (b.scene_prompt || "").trim());
  const missingScene = gen.filter((b) => !(b.scene_prompt || "").trim());
  const badGenLen = gen.filter((b) => ![4, 6, 8].includes(b.generate_seconds));
  const notTrimmed = gen.filter((b) => b.use_seconds > (b.generate_seconds ?? 0));
  const banned = ["beautiful", "stunning", "amazing", "breathtaking", "epic", "vibes"];
  const hitBanned = banned.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(allScenes));
  const introBeat = beats.find((b) => b.id === "intro");
  // The CTA keyword itself contains the brand name, so it is stripped before counting -
  // otherwise every reel reads as saying "Travafa" twice.
  const ctaKeyword = JOB.ctaKeyword ?? "Comment TRAVAFA";
  const voSansCta = vo.split(ctaKeyword).join(" ");
  const brandInVo = (voSansCta.match(/\bTravafa\b/gi) || []).length;
  const firstLine = (out.caption || "").split("\n")[0];
  const supplied = JOB.topic + " " + JSON.stringify(JOB.facts ?? {});
  const numbers = [...(out.caption + " " + vo + " " + beats.map((b) => b.on_screen_text).join(" "))
    .matchAll(/(?:₹|\bRs\.?|\bINR)[ ]?[\d,]*\d(?:\.\d+)?k?|\b\d[\d,]*(?:\.\d+)?[ ]?(?:k\b|%|percent\b)/gi)]
    .map((m) => m[0].trim())
    .filter((n) => !supplied.replace(/[,\s]/g, "").includes(n.replace(/[^\d.]/g, "")));
  const dialKeys = Object.keys(JOB.dials);
  const missingEcho = dialKeys.filter((k) => !(k in (out.dials_used || {})));
  const mismatched = Object.entries(out.dials_used || {}).filter(([k, v]) => JOB.dials[k] !== v);

  checks = [
    ["six beats, ids and order",       planMismatch.length === 0,        planMismatch.map((b) => b.id).join(", ") || beats.map((b) => b.id).join(" → ")],
    ["scene only on generated beats",  strayScene.length === 0 && missingScene.length === 0, [...strayScene, ...missingScene].map((b) => b.id).join(", ") || "ok"],
    ["clip lengths are 4, 6 or 8",     badGenLen.length === 0,           badGenLen.map((b) => `${b.id}=${b.generate_seconds}`).join(", ") || gen.map((b) => b.generate_seconds + "s").join(" ")],
    ["clips longer than the cut",      notTrimmed.length === 0,          notTrimmed.map((b) => b.id).join(", ") || gen.map((b) => `${b.use_seconds}/${b.generate_seconds}`).join(" ")],
    ["every beat has text",            emptyText.length === 0,           emptyText.map((b) => b.id).join(", ") || "all 6"],
    ["text at most 7 words",           longText.length === 0,            longText.map((b) => `${b.id}=${words(b.on_screen_text)}w`).join(", ") || beats.map((b) => words(b.on_screen_text)).join("/")],
    ["voiceover fits its beat",        overBudget.length === 0,          overBudget.map((b) => `${b.id} ${words(b.voiceover)}w/${Math.round(b.use_seconds * 2.5)}`).join(", ") || "all fit"],
    ["no speech in scene prompts",     !/\bsays|speaks|replies|asks|tells|voice-?over|dialogue\b/i.test(allScenes) && !quoted.trim(), quoted.slice(0, 40)],
    ["no text described in scenes",    !/\b(text|caption|subtitle|words on screen|title card)\b/i.test(allScenes.replace(/\b(no|without)\s+(visible\s+|readable\s+)?(text|caption|words)\w*/gi, "")), ""],
    ["brand spoken once, in intro",    brandInVo === 1 && /\bTravafa\b/i.test(introBeat?.voiceover || ""), `${brandInVo}x in narration`],
    ["no banned adjectives",           hitBanned.length === 0,           hitBanned.join(", ") || "clean"],
    ["no crowd language",              !/\b(group of|crowd|four friends|three friends|a group)\b/i.test(allScenes), ""],
    ["dials echoed complete",          missingEcho.length === 0,         missingEcho.join(", ") || `all ${dialKeys.length}`],
    ["dials echoed correct",           mismatched.length === 0,          mismatched.map(([k, v]) => `${k}=${v}`).join(", ") || "match input"],
    ["hook line under 125 chars",      firstLine.length <= 125,          `${firstLine.length} chars`],
    ["CTA keyword in caption",         (out.caption || "").includes(JOB.ctaKeyword ?? "Comment TRAVAFA"), ""],
    ["exactly 8 hashtags",             (out.hashtags || []).length === 8, String((out.hashtags || []).length)],
    ["no invented numbers",            numbers.length === 0,             numbers.join(", ") || "all traceable"],
  ];

  failed = checks.filter(([, ok]) => !ok).length;
  if (failed === 0 || attempt === MAX_ATTEMPTS) break;
  console.log(`attempt ${attempt}: ${failed} check(s) failed, regenerating...`);
}

console.log("\n" + "─".repeat(74));
for (const b of out.beats) {
  const tag = b.source === "generated" ? `gen ${b.generate_seconds}s → ${b.use_seconds}s` : `${b.source} ${b.use_seconds}s`;
  console.log(`\n▸ ${b.id.toUpperCase()}  (${tag})`);
  console.log(`  TEXT  “${b.on_screen_text}”`);
  console.log(`  VO    “${b.voiceover}”`);
  if (b.scene_prompt) console.log(`  SCENE ${b.scene_prompt}`);
}
console.log("\n" + "─".repeat(74) + "\nNARRATION READ STRAIGHT THROUGH\n");
console.log("  " + out.beats.map((b) => b.voiceover).join(" "));
console.log("\nTEXT READ ALONE\n");
out.beats.forEach((b) => console.log(`  ${b.on_screen_text}`));
console.log("\n" + "─".repeat(74) + "\nCAPTION\n\n" + out.caption);
console.log("\nHASHTAGS: " + (out.hashtags || []).map((h) => "#" + h).join(" "));
console.log("DIAL CONFLICT: " + (out.dial_conflict || "(none)"));

console.log("\n" + "─".repeat(74) + `\nCHECKS  (attempt ${attempt} of ${MAX_ATTEMPTS})\n`);
for (const [name, ok, detail] of checks) console.log(`${ok ? "✓" : "✗"} ${name.padEnd(30)} ${detail}`);
console.log(`\n${checks.length - failed}/${checks.length} passed`);

fs.writeFileSync(JOB.out ?? "prompts/_beats-out.json", JSON.stringify({ dials: JOB.dials, plan, output: out }, null, 2));
console.log("full output → " + (JOB.out ?? "prompts/_beats-out.json"));
