#!/usr/bin/env node
/**
 * gen-skill-version.js — stamp a skill's identity into scripts/skill-version.json.
 *
 * Generalized: works for ANY skill dir. Computes the live identity
 * (plugin@version+hash via lib/skill-version.js) and writes it so the skill can
 * self-report even when its scripts are vendored into a plan or external repo
 * where the plugin manifest is no longer adjacent.
 *
 * Run at publish time (wire into `sox sync`) and any time the skill's scripts/
 * or templates/ change:
 *   node scripts/gen-skill-version.js [<skill-dir>]   # default: this skill
 *
 * Node stdlib only.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computeIdentity } from "./lib/skill-version.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function main() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const skillDir = arg ? path.resolve(arg) : path.dirname(SCRIPT_DIR);

  const identity = computeIdentity(skillDir);
  const out = {
    plugin: identity.plugin,
    version: identity.version,
    hash: identity.hash,
    id: identity.id,
    generated_at: new Date().toISOString(),
  };
  const dest = path.join(skillDir, "scripts", "skill-version.json");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`);
  process.stdout.write(`gen-skill-version: ${identity.id} → ${dest}\n`);
  process.exit(0);
}

main();
