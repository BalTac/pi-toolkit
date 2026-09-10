#!/usr/bin/env node
/**
 * patch-llm-wiki-status.mjs — move the llm-wiki status lines onto their own line
 *
 * WHY
 * pi renders every extension status set with `ctx.ui.setStatus()` on a SINGLE
 * footer line, joined with a space and sorted by key (see pi's
 * dist/modes/interactive/components/footer.js). Newlines are stripped by
 * `sanitizeStatusText()`, so no status text can force a line break. With
 * `deepseek-balance` also writing there, the wiki badge and the active
 * background-model label end up appended to (and eventually truncated by) the
 * balance line.
 *
 * WHAT
 * The llm-wiki package writes exactly three statuses:
 *   lib/visible-status.js  → "llm-wiki"         (the "🧠 LLM Wiki (N tools…)" badge)
 *   lib/visible-status.js  → MODEL_STATUS_KEY   ("🧠 wiki model: …")
 *   lib/model-command.js   → MODEL_STATUS_KEY   ("🧠 wiki model: …", after /wiki-model)
 * This script rewrites those three calls to `setWidget(..., { placement:
 * "belowEditor" })`, so both lines render on their own line just below the
 * editor, above the footer, instead of sharing the footer line.
 *
 * USAGE
 *   node scripts/patch-llm-wiki-status.mjs           # apply (idempotent)
 *   node scripts/patch-llm-wiki-status.mjs --revert  # restore the original calls
 *   node scripts/patch-llm-wiki-status.mjs --check   # report state, change nothing
 *
 * NOTE: this patches a third-party package inside node_modules. A package
 * update (pi install/update of @zosmaai/pi-llm-wiki) restores the original
 * files — re-run this script after updating. `--revert` is the rollback.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PKG_REL = join(
  "agent",
  "npm",
  "node_modules",
  "@zosmaai",
  "pi-llm-wiki",
  "dist",
  "extensions",
  "llm-wiki",
  "lib",
);
const LIB = join(homedir(), ".pi", PKG_REL);

const TARGETS = ["visible-status.js", "model-command.js"];

/** The three rewrites — each with an exact apply matcher and an exact undo matcher. */
const RULES = [
  {
    file: "visible-status.js",
    name: "badge",
    // setStatus("llm-wiki", <ternary>);  ->  setWidget("llm-wiki", [<ternary>], { placement });
    re: /opts\.ui\.setStatus\("llm-wiki",\s*([\s\S]*?)\);/,
    build: (m) => `opts.ui.setWidget("llm-wiki", [${m[1]}], { placement: "belowEditor" });`,
    detect: /opts\.ui\.setWidget\("llm-wiki"/,
    unre: /opts\.ui\.setWidget\("llm-wiki", \[([\s\S]*?)\], \{ placement: "belowEditor" \}\);/,
    unbuild: (m) => `opts.ui.setStatus("llm-wiki", ${m[1]});`,
  },
  {
    file: "visible-status.js",
    name: "model label (session start)",
    re: /opts\.ui\.setStatus\(MODEL_STATUS_KEY,\s*(`🧠 wiki model: \$\{modelLabel\}`)\);/,
    build: (m) => `opts.ui.setWidget(MODEL_STATUS_KEY, [${m[1]}], { placement: "belowEditor" });`,
    detect: /opts\.ui\.setWidget\(MODEL_STATUS_KEY/,
    unre: /opts\.ui\.setWidget\(MODEL_STATUS_KEY, \[(`🧠 wiki model: \$\{modelLabel\}`)\], \{ placement: "belowEditor" \}\);/,
    unbuild: (m) => `opts.ui.setStatus(MODEL_STATUS_KEY, ${m[1]});`,
  },
  {
    file: "model-command.js",
    name: "model label (/wiki-model)",
    re: /ctx\.ui\.setStatus\(MODEL_STATUS_KEY,\s*(`🧠 wiki model: \$\{label\}`)\);/,
    build: (m) => `ctx.ui.setWidget(MODEL_STATUS_KEY, [${m[1]}], { placement: "belowEditor" });`,
    detect: /ctx\.ui\.setWidget\(MODEL_STATUS_KEY/,
    unre: /ctx\.ui\.setWidget\(MODEL_STATUS_KEY, \[(`🧠 wiki model: \$\{label\}`)\], \{ placement: "belowEditor" \}\);/,
    unbuild: (m) => `ctx.ui.setStatus(MODEL_STATUS_KEY, ${m[1]});`,
  },
];

const mode = process.argv.includes("--revert")
  ? "revert"
  : process.argv.includes("--check")
    ? "check"
    : "apply";

if (!existsSync(LIB)) {
  console.error(`✖ llm-wiki package not found at ${LIB}`);
  process.exit(1);
}

let changed = 0;
let alreadyOk = 0;
let missing = 0;

for (const rule of RULES) {
  const file = join(LIB, rule.file);
  if (!existsSync(file)) {
    console.log(`  ⚠ ${rule.file}: file not found`);
    missing++;
    continue;
  }
  const original = readFileSync(file, "utf8");
  const isPatched = rule.detect.test(original);

  if (mode === "check") {
    console.log(`  ${isPatched ? "✅ patched " : "⬜ original"} ${rule.file} — ${rule.name}`);
    continue;
  }

  if (mode === "apply") {
    if (isPatched) {
      console.log(`  ↩ ${rule.file} — ${rule.name}: già patchato`);
      alreadyOk++;
      continue;
    }
    const m = original.match(rule.re);
    if (!m) {
      console.log(`  ⚠ ${rule.file} — ${rule.name}: pattern non trovato (versione diversa?)`);
      missing++;
      continue;
    }
    writeFileSync(file, original.replace(rule.re, rule.build(m)), "utf8");
    console.log(`  ✅ ${rule.file} — ${rule.name}: patchato`);
    changed++;
    continue;
  }

  // revert
  if (!isPatched) {
    console.log(`  ↩ ${rule.file} — ${rule.name}: già originale`);
    alreadyOk++;
    continue;
  }
  const um = original.match(rule.unre);
  if (!um) {
    console.log(`  ⚠ ${rule.file} — ${rule.name}: forma patchata inattesa`);
    missing++;
    continue;
  }
  writeFileSync(file, original.replace(rule.unre, rule.unbuild(um)), "utf8");
  console.log(`  ✅ ${rule.file} — ${rule.name}: ripristinato`);
  changed++;
}

if (mode !== "check") console.log(`\n  Modifiche: ${changed} · già a posto: ${alreadyOk} · problemi: ${missing}`);
console.log(
  "  Restart pi to see the change. Re-run this script after updating @zosmaai/pi-llm-wiki.\n",
);
