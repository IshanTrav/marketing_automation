// Chooses the creative dials for the next post, and turns them into brief fields.
//
// This is the part that makes two posts different from each other. The template writes a
// good prompt from whatever brief it is handed; nothing inside it knows what yesterday's
// post looked like. Left to itself the model converges - warm morning light, muted grade,
// the same shape every time - so the variation has to be decided here, against history,
// before the template ever runs.
//
// Four rules, all declared in dials.json:
//   cooldown    a value cannot return within N posts
//   throttle    a value has a ceiling within a window, tighter than its cooldown
//   pairs       combinations that are physically or narratively impossible
//   change rule enough PRIMARY dials must differ from the previous post, and the primary
//               combination must not have appeared in the recent window
//
// Usage: node dial-picker.js [history.json] [--out brief-fields.json]

import fs from "node:fs";

const DIALS = JSON.parse(fs.readFileSync(new URL("./dials.json", import.meta.url), "utf8"));

export const dialNames = () => Object.keys(DIALS.dials).filter((k) => !k.startsWith("$"));
export const primaryNames = () => dialNames().filter((n) => DIALS.dials[n].impact === "primary");

/** Violations of the declared rules. Empty means the combination is legal. */
export function validateCombo(chosen) {
  const errors = [];
  for (const [name, id] of Object.entries(chosen)) {
    const dial = DIALS.dials[name];
    if (!dial) { errors.push(`unknown dial: ${name}`); continue; }
    if (!dial.values.some((v) => v.id === id)) errors.push(`unknown value for ${name}: ${id}`);
  }
  for (const name of dialNames()) if (!(name in chosen)) errors.push(`missing dial: ${name}`);

  const active = new Set(Object.entries(chosen).map(([n, id]) => `${n}:${id}`));
  for (const [a, b] of DIALS.incompatibilities.pairs) {
    if (active.has(a) && active.has(b)) errors.push(`incompatible: ${a} + ${b}`);
  }
  for (const rule of DIALS.incompatibilities.allowed_only_with) {
    if (active.has(rule.value) && !rule.requires_one_of.some((r) => active.has(r))) {
      errors.push(`${rule.value} requires one of ${rule.requires_one_of.join(" | ")}`);
    }
  }
  return errors;
}

const weightedPick = (values, weights) => {
  const total = values.reduce((a, v) => a + (weights?.[v.id] ?? 1), 0);
  let r = Math.random() * total;
  for (const v of values) { r -= weights?.[v.id] ?? 1; if (r <= 0) return v.id; }
  return values[values.length - 1].id;
};

/**
 * Values still open for a dial, given history.
 * `relax` drops the soft rules in a fixed order when nothing is left - a picker that
 * silently reuses a value is worse than one that says which rule it had to bend.
 */
function candidates(name, history, relax = 0, bent = null) {
  const dial = DIALS.dials[name];
  let vals = dial.values;

  if (relax < 2) {
    const recent = history.slice(0, dial.cooldown).map((h) => h.dials?.[name]);
    const open = vals.filter((v) => !recent.includes(v.id));
    // Falling back to the full set is how a cooldown quietly stops applying. It is
    // allowed, but it is never silent.
    if (open.length) vals = open;
    else bent?.add(`${name} cooldown`);
  }
  if (relax < 1) {
    for (const t of DIALS.throttles ?? []) {
      if (t.dial !== name) continue;
      const used = history.slice(0, t.window_posts).filter((h) => h.dials?.[name] === t.value).length;
      if (used >= t.max_uses_per_window) {
        const open = vals.filter((v) => v.id !== t.value);
        if (open.length) vals = open;
        else bent?.add(`${name} throttle`);
      }
    }
  }
  return vals;
}

/** Catches rules that can never hold, rather than letting them fail quietly at runtime. */
export function auditRules() {
  const problems = [];
  for (const name of dialNames()) {
    const dial = DIALS.dials[name];
    if (dial.cooldown > dial.values.length - 1) {
      problems.push(`${name}: cooldown ${dial.cooldown} with only ${dial.values.length} values - nothing would remain to pick`);
    }
  }
  const primaries = primaryNames();
  if (DIALS.change_rule.primary_min_changes_vs_previous_post > primaries.length) {
    problems.push(`change rule asks for ${DIALS.change_rule.primary_min_changes_vs_previous_post} primary changes but only ${primaries.length} primary dials exist`);
  }
  return problems;
}

/**
 * @param {object[]} history newest first, each `{ posted_on, dials }`
 * @returns {{dials: object, relaxed: string[], attempts: number}}
 */
export function pick(history = []) {
  const prev = history[0]?.dials;
  const rule = DIALS.change_rule;
  const primaries = primaryNames();
  const minChange = Math.min(rule.primary_min_changes_vs_previous_post, primaries.length);
  const seen = new Set(
    history.slice(0, rule.primary_tuple_unique_within_last_n_posts)
      .map((h) => primaries.map((n) => h.dials?.[n]).join("|"))
  );

  const audit = auditRules();
  if (audit.length) throw new Error("dials.json contains unsatisfiable rules:\n  - " + audit.join("\n  - "));

  const relaxed = [];
  for (let relax = 0; relax <= 3; relax++) {
    for (let attempt = 1; attempt <= 400; attempt++) {
      const bent = new Set();
      const chosen = {};
      for (const name of dialNames()) {
        chosen[name] = weightedPick(candidates(name, history, relax, bent), DIALS.dials[name].weights);
      }
      if (validateCombo(chosen).length) continue;

      if (relax < 3 && prev) {
        const changed = primaries.filter((n) => chosen[n] !== prev[n]).length;
        if (changed < minChange) continue;
        if (seen.has(primaries.map((n) => chosen[n]).join("|"))) continue;
      }
      bent.forEach((b) => relaxed.push(b));
      if (relax >= 1) relaxed.push("throttles");
      if (relax >= 2) relaxed.push("cooldowns");
      if (relax >= 3) relaxed.push("change rule");
      return { dials: chosen, relaxed: [...new Set(relaxed)], attempts: attempt };
    }
  }
  throw new Error("no legal dial combination exists - the rules in dials.json contradict each other");
}

/** Turns chosen dials into the fields the prompt template consumes. */
export function toBriefFields(chosen) {
  const text = (n) => DIALS.dials[n].values.find((v) => v.id === chosen[n]).prompt_text;
  const by = (target) => dialNames().filter((n) => DIALS.dials[n].feeds === target);

  // LOOK_CONSTRAINTS, CREATIVE_ANGLE and CAPTION are composite: several dials join into
  // one "name: text; name: text" string. Everything else (PRODUCT_FOCUS, PHONE_SHOT_ACTION)
  // is a direct passthrough - exactly one dial feeds it, and its text becomes the field.
  const COMPOSITE = ["LOOK_CONSTRAINTS", "CREATIVE_ANGLE", "CAPTION"];
  const passthroughTargets = new Set(dialNames().map((n) => DIALS.dials[n].feeds).filter((t) => !COMPOSITE.includes(t)));

  const fields = {
    LOOK_CONSTRAINTS: by("LOOK_CONSTRAINTS").map((n) => `${n}: ${text(n)}`).join("; "),
    CREATIVE_ANGLE_DIALS: by("CREATIVE_ANGLE").map((n) => `${n}: ${text(n)}`).join("; "),
    CAPTION_DIALS: by("CAPTION").map((n) => `${n}: ${text(n)}`).join("; "),
    $dials: chosen,
  };
  for (const target of passthroughTargets) {
    const feeders = by(target);
    if (feeders.length !== 1) throw new Error(`${target} must be fed by exactly one dial, got: ${feeders.join(", ") || "none"}`);
    fields[target] = text(feeders[0]);
  }
  return fields;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const historyPath = args.find((a) => !a.startsWith("--") && a !== args[outIdx + 1]) || "prompts/history.json";
  const history = fs.existsSync(historyPath) ? JSON.parse(fs.readFileSync(historyPath, "utf8")) : [];

  const { dials, relaxed, attempts } = pick(history);
  const fields = toBriefFields(dials);

  console.log(`history: ${history.length} post${history.length === 1 ? "" : "s"}  |  found in ${attempts} attempt${attempts === 1 ? "" : "s"}`);
  if (relaxed.length) console.log(`RELAXED: ${relaxed.join(", ")} - not enough history or values to satisfy every rule`);
  console.log();
  for (const n of dialNames()) {
    const mark = DIALS.dials[n].impact === "primary" ? "*" : " ";
    const prevVal = history[0]?.dials?.[n];
    const flag = prevVal && prevVal === dials[n] ? "  (same as last)" : "";
    console.log(` ${mark} ${n.padEnd(18)} ${dials[n]}${flag}`);
  }
  if (history[0]) {
    const changed = primaryNames().filter((n) => dials[n] !== history[0].dials?.[n]);
    console.log(`\n${changed.length} of ${primaryNames().length} primary dials differ from the last post: ${changed.join(", ")}`);
  }
  console.log(`\nLOOK_CONSTRAINTS\n  ${fields.LOOK_CONSTRAINTS}`);

  if (outIdx >= 0) {
    fs.writeFileSync(args[outIdx + 1], JSON.stringify(fields, null, 2) + "\n");
    console.log(`\n→ ${args[outIdx + 1]}`);
  }
}
