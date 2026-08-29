// Turns a bare topic into the unified brief that gen-3refs.js and gen-veo-prompt.js
// both consume. This is the step that used to be open-ended conversation - it has to be
// a deterministic pipeline stage instead, because whatever calls this is code.
//
// Two things are decided by CODE, not by the model, and never asked of it:
//   PRODUCT_FOCUS       dial-picker.js rotates the four approved features, so the model
//                        can't default to the same one every time
//   LOOK_CONSTRAINTS     dial-picker.js rotates look/mood against posting history
// Everything else (pain point, audience, creative angle, character, setting, tone) is
// written by Gemini against prompts/system-prompt.brief.md.
//
// Usage: node gen-brief.js "<topic>" [out.json]
//   --objective <awareness|consideration|action>   default: consideration
//   --language <...>                               default: Hinglish
//   --cta <...>                                     default: Comment TRAVAFA
//   --duration <seconds>                            default: 19
//   --final-part-seconds <seconds>                  default: 3, or 8 (no trim) when the
//                                                     ending_style dial picks direct_to_camera
//   --destination <...>                             optional, otherwise the model infers it
//   --no-history                                    don't append the chosen dials to history.json

import "dotenv/config";
import fs from "node:fs";
import { GoogleGenAI } from "@google/genai";
import { pick, toBriefFields } from "./dial-picker.js";

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const topic = positional[0];
const outPath = positional[1];
if (!topic) { console.error('usage: node gen-brief.js "<topic>" [out.json]'); process.exit(1); }

const OBJECTIVE = flag("objective", "consideration");
const LANGUAGE = flag("language", "Hinglish");
const CTA = flag("cta", "Comment TRAVAFA");
const TOTAL_DURATION_SECONDS = Number(flag("duration", 19));
const finalPartSecondsFlag = flag("final-part-seconds", null);   // null = let ending_style decide
const destinationOverride = flag("destination", null);
const skipHistory = argv.includes("--no-history");

const SYSTEM_PROMPT = "prompts/system-prompt.brief.md";
const MODEL = process.env.PROMPT_MODEL || "gemini-3.7-flash";
const HISTORY_PATH = "prompts/history.json";

// --- code-controlled dials: PRODUCT_FOCUS and LOOK_CONSTRAINTS never come from the LLM --

const history = fs.existsSync(HISTORY_PATH) ? JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")) : [];
const { dials: chosen, relaxed, attempts } = pick(history);
const dialFields = toBriefFields(chosen);
console.log(`dials: ${chosen.product_focus} | ${chosen.hook_style} | ${chosen.pacing_shape} | ${chosen.ending_style} | ${chosen.dialogue_density}`
  + ` (${attempts} attempt${attempts === 1 ? "" : "s"}${relaxed.length ? `, relaxed: ${relaxed.join(", ")}` : ""})`);

// direct_to_camera speaks the CTA in the final part itself - trimming that part down to a
// few seconds would cut the line off mid-sentence, the exact failure this whole rebuild
// was fixing. Only payoff_environment (silent) suits a short CTA-landing trim.
const FINAL_PART_SECONDS = finalPartSecondsFlag != null
  ? Number(finalPartSecondsFlag)
  : (chosen.ending_style === "direct_to_camera" ? 8 : 3);

// --- ask Gemini for everything that requires actually knowing the topic -----------------

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    DESTINATION: { type: "string" },
    TARGET_AUDIENCE: { type: "string" },
    PAIN_POINT: { type: "string" },
    CREATIVE_ANGLE: { type: "string" },
    CharacterStyle: { type: "string" },
    Setting: { type: "string" },
    ReferenceTone: { type: "string" },
    PhoneShotAction: { type: "string" },
  },
  required: ["DESTINATION", "TARGET_AUDIENCE", "PAIN_POINT", "CREATIVE_ANGLE",
    "CharacterStyle", "Setting", "ReferenceTone", "PhoneShotAction"],
};

const fixedInputs = {
  TOPIC: topic,
  PRODUCT_FOCUS: dialFields.PRODUCT_FOCUS,
  PHONE_SHOT_ACTION_SHAPE: dialFields.PHONE_SHOT_ACTION,
  LOOK_CONSTRAINTS: dialFields.LOOK_CONSTRAINTS,
  OBJECTIVE, LANGUAGE, CTA,
  ...(destinationOverride ? { DESTINATION: destinationOverride } : {}),
};

const userTurn = [
  "Fill the brief for this topic. The fixed inputs below are decided already - do not",
  "change PRODUCT_FOCUS or LOOK_CONSTRAINTS, and shape PhoneShotAction to the given manner.",
  "",
  "```json",
  JSON.stringify(fixedInputs, null, 2),
  "```",
].join("\n");

const systemPrompt = fs.readFileSync(SYSTEM_PROMPT, "utf8");
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

console.log(`template=${SYSTEM_PROMPT}  model=${MODEL}  topic="${topic}"`);
const res = await ai.models.generateContent({
  model: MODEL,
  contents: userTurn,
  config: { systemInstruction: systemPrompt, temperature: 1.0, responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
});
const written = JSON.parse(res.text);

// The model must echo PRODUCT_FOCUS back unchanged - it's a self-check, not a re-ask.
// It writes DESTINATION only when not already fixed above.

// --- assemble the unified brief ----------------------------------------------------------

const brief = {
  OBJECTIVE, LANGUAGE, TOPIC: topic,
  TARGET_AUDIENCE: written.TARGET_AUDIENCE,
  PAIN_POINT: written.PAIN_POINT,
  PRODUCT_FOCUS: dialFields.PRODUCT_FOCUS,
  DESTINATION: destinationOverride || written.DESTINATION,
  CREATIVE_ANGLE: written.CREATIVE_ANGLE,
  CTA,
  TOTAL_DURATION_SECONDS,
  FINAL_PART_SECONDS,
  LOOK_CONSTRAINTS: dialFields.LOOK_CONSTRAINTS,
  // Structural dials, code-controlled like PRODUCT_FOCUS - the template branches on
  // these directly, so they are never asked of the brief-writing LLM call above.
  HOOK_STYLE: dialFields.HOOK_STYLE,
  PACING_SHAPE: dialFields.PACING_SHAPE,
  ENDING_STYLE: dialFields.ENDING_STYLE,
  DIALOGUE_DENSITY: dialFields.DIALOGUE_DENSITY,
  CharacterStyle: written.CharacterStyle,
  Setting: written.Setting,
  ReferenceTone: written.ReferenceTone,
  PhoneShotAction: written.PhoneShotAction,
  $dials: chosen,
};

console.log(`\nPRODUCT_FOCUS: ${brief.PRODUCT_FOCUS}`);
console.log(`DESTINATION:   ${brief.DESTINATION}`);
console.log(`PAIN_POINT:    ${brief.PAIN_POINT}`);
console.log(`\n${JSON.stringify(brief, null, 2)}`);

if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify(brief, null, 2) + "\n");
  console.log(`\n→ ${outPath}`);
}

if (!skipHistory) {
  // Newest-first, matching pick()'s own convention. This is what makes cooldown and the
  // change rule mean anything on the *next* call - skip only for a discarded draft.
  history.unshift({ posted_on: new Date().toISOString().slice(0, 10), topic, dials: chosen });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n");
  console.log(`→ ${HISTORY_PATH} (${history.length} posts)`);
}
