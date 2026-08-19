#!/usr/bin/env node
// Skill-activation / routing eval (#497, pattern from eliasstravik/skills).
// Tests the REAL failure mode of a 50-skill library: given a user request, does
// the right skill's description win the route, and do adjacent skills stay quiet?
// It reads every skill's `description` (the routing signal), asks a pinned judge
// which ONE skill should handle each labeled query, and reports routing accuracy
// + the confusions (which skill wrongly grabbed it).
//
// A case may also list `forbidden` skills — named adjacent skills that must stay
// quiet for that query. Routing to one is a scope-boundary violation: the worst
// miss class, because it means two descriptions are actively fighting over the
// query (pattern from AgriciDaniel/claude-ads routing evals, MIT).
//
//   node trigger-harness.mjs                 # uses triggers/router.json
//   node trigger-harness.mjs my-set.json
//
// Needs ANTHROPIC_API_KEY or OPENAI_API_KEY. Judge pinned to temperature 0.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callModel, parseJsonArray, activeModel } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(HERE, "../skills");
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

// Read `name` + `description` from each skill's SKILL.md frontmatter.
function loadCatalog() {
  const out = [];
  for (const name of readdirSync(SKILLS_DIR)) {
    const p = resolve(SKILLS_DIR, name, "SKILL.md");
    if (!existsSync(p)) continue;
    const fm = readFileSync(p, "utf8").split(/\n---\n|\n---\r?\n/)[0];
    const nm = fm.match(/\nname:\s*(.+)/)?.[1]?.trim();
    const desc = fm.match(/\ndescription:\s*(.+)/)?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (nm && desc) out.push({ name: nm, description: desc });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const setPath = resolve(process.argv[2] ? resolve(process.argv[2]) : resolve(HERE, "triggers/router.json"));
const set = JSON.parse(readFileSync(setPath, "utf8"));
const cases = Array.isArray(set) ? set : set.cases;
const catalog = loadCatalog();
const names = new Set(catalog.map((c) => c.name));

// Catch label typos up front: a forbidden name that isn't a real skill can never
// fire, which would silently weaken the assertion.
for (const c of cases)
  for (const f of c.forbidden ?? [])
    if (!names.has(f)) console.error(dim(`  ⚠ unknown forbidden skill "${f}" in case: ${c.query}`));

const system =
  `You are the router for a marketing-skills library. Given a user request, choose the ONE skill whose description best fits it. ` +
  `Use only a skill name from the catalog, or "none" if nothing fits. Prefer the most specific skill (e.g. ad copy → ad-creative, not copywriting; editing existing copy → copy-editing, not copywriting).\n\n` +
  `CATALOG:\n` +
  catalog.map((c) => `- ${c.name}: ${c.description}`).join("\n") +
  `\n\nFor each numbered request, return ONLY a JSON array of { "index": <n>, "skill": "<name-or-none>" }.`;

const BATCH = 20;
console.error(dim(`routing ${cases.length} queries across ${catalog.length} skills with ${activeModel()} (temp 0)…\n`));

let correct = 0, graded = 0;
const misses = [];
for (let i = 0; i < cases.length; i += BATCH) {
  const batch = cases.slice(i, i + BATCH);
  const numbered = batch.map((c, j) => `${j + 1}. ${c.query}`).join("\n");
  const { text } = await callModel(system, `Route these requests:\n\n${numbered}`, { temperature: 0 });
  const results = parseJsonArray(text);
  // Map by 1-based batch index, defensively: keep only in-range indices, first
  // wins on duplicates, and count anything malformed/extra/out-of-range so a
  // sloppy model response is visible rather than silently swallowed.
  const byIdx = new Map();
  let malformed = 0;
  for (const r of results) {
    const idx = r && r.index;
    if (Number.isInteger(idx) && idx >= 1 && idx <= batch.length && !byIdx.has(idx)) byIdx.set(idx, r);
    else malformed++;
  }
  if (malformed) console.error(dim(`  ⚠ ${malformed} malformed/duplicate/out-of-range result(s) ignored in this batch`));
  batch.forEach((c, j) => {
    const got = (byIdx.get(j + 1)?.skill ?? "").trim();
    graded++;
    if (got === c.expected) correct++;
    else misses.push({
      query: c.query,
      expected: c.expected,
      got: got || "(none returned)",
      hallucinated: got && got !== "none" && !names.has(got),
      boundary: (c.forbidden ?? []).includes(got),
    });
  });
  console.error(dim(`  ${Math.min(i + BATCH, cases.length)}/${cases.length}`));
}

const pct = ((correct / graded) * 100).toFixed(1);
const boundaryCount = misses.filter((m) => m.boundary).length;
console.log(`\nRouting accuracy: ${correct}/${graded} = ${pct}%`);
if (boundaryCount) console.log(`Scope-boundary violations: ${boundaryCount} (a forbidden adjacent skill grabbed the query — fix these descriptions first)`);
if (misses.length) {
  console.log(`\nMis-routes (the confusions to fix in descriptions):`);
  for (const m of misses) {
    const flags = [m.boundary ? "⚠ FORBIDDEN for this query" : "", m.hallucinated ? "⚠ not a real skill" : ""].filter(Boolean).join(" ");
    console.log(`  "${m.query}"\n    expected ${m.expected} → got ${m.got}${flags ? " " + flags : ""}`);
  }
}
