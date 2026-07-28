#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const skillPath = join(root, "skills/artfromclt-writing/SKILL.md");
const casesPath = join(root, "evals/cases.json");
const live = process.argv.includes("--live");
const skill = readFileSync(skillPath, "utf8");
const cases = JSON.parse(readFileSync(casesPath, "utf8"));
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

check(skill.startsWith("---\nname: artfromclt-writing\n"), "skill frontmatter name is invalid");
check(skill.includes("Do not use merely because prose needs writing."), "skill must exclude generic-writing triggers");
check(skill.includes("Caveman governs the agent's surrounding status"), "skill must define Caveman coordination");
check(skill.includes("Ponytail governs implementation scope"), "skill must define Ponytail coordination");
check(skill.includes("## Precedence"), "skill must define precedence for user constraints and domain skills");
check(skill.includes("Do not claim strict ASD-STE100 conformance"), "skill must not claim unverified STE compliance");
check(skill.length < 8_000, "skill is too large for progressive disclosure");

for (const testCase of cases) {
  check(typeof testCase.id === "string", "each eval case needs an id");
  check(typeof testCase.prompt === "string", `${testCase.id}: prompt is missing`);
  check(Array.isArray(testCase.mustContain), `${testCase.id}: mustContain is missing`);
  check(testCase.mustContainAny === undefined || testCase.mustContainAny.every(Array.isArray), `${testCase.id}: mustContainAny must contain phrase groups`);
  check(Array.isArray(testCase.mustNotContain), `${testCase.id}: mustNotContain is missing`);
}

if (live && failures.length === 0) {
  for (const testCase of cases) {
    const result = spawnSync(
      "pi",
      ["--no-skills", "--skill", skillPath, "--print", "--no-session", testCase.prompt],
      { encoding: "utf8", timeout: 120_000 },
    );
    const output = `${result.stdout}\n${result.stderr}`;

    const caseFailures = [];
    if (result.status !== 0) caseFailures.push(`pi exited with ${result.status ?? "no status"}`);
    for (const phrase of testCase.mustContain) {
      if (!output.toLowerCase().includes(phrase.toLowerCase())) {
        caseFailures.push(`missing required text ${JSON.stringify(phrase)}`);
      }
    }
    for (const phrases of testCase.mustContainAny ?? []) {
      if (!phrases.some((phrase) => output.toLowerCase().includes(phrase.toLowerCase()))) {
        caseFailures.push(`missing one of ${JSON.stringify(phrases)}`);
      }
    }
    for (const phrase of testCase.mustNotContain) {
      if (output.toLowerCase().includes(phrase.toLowerCase())) {
        caseFailures.push(`contains forbidden text ${JSON.stringify(phrase)}`);
      }
    }
    if (caseFailures.length > 0) {
      failures.push(`${testCase.id}: ${caseFailures.join("; ")}\n  Output: ${JSON.stringify(output.trim())}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`artfromclt-writing eval failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

console.log(`artfromclt-writing ${live ? "live" : "static"} eval passed (${cases.length} cases).`);
