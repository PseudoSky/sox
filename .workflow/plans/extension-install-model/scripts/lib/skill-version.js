/**
 * skill-version.js — generalized skill-identity tool (plugin version + content hash).
 *
 * A reusable versioning primitive for ANY skill whose durable artifacts (plans,
 * configs, generated files) need to record *which skill produced them*, so drift
 * and migration are decidable by identity rather than by sniffing field shapes.
 *
 * Identity = `<plugin>@<version>+<hash>` (semver build-metadata form):
 *   - plugin/version come from the nearest `.claude-plugin/plugin.json` (the
 *     release the skill ships in).
 *   - hash is a sha256 (12 hex) over the skill's BEHAVIOR-defining files
 *     (scripts/lib *.js, *.schema.json, templates/*) — NOT prose (SKILL.md) — so
 *     it changes whenever runtime/format behavior changes, even within one
 *     plugin version. Finer-grained than the plugin version alone.
 *
 * Vendoring: once a skill's scripts are copied into a plan or external repo, the
 * plugin manifest is no longer adjacent — so `gen-skill-version.js` stamps a
 * `scripts/skill-version.json` at publish time and consumers read THAT
 * (`readStampedIdentity`), falling back to a live compute only in the skill
 * source. Node stdlib only.
 *
 * This is the generalized tool documented in
 * docs/catalog/skill-versioning.md (workflow-agent-builder's skill-building doc).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const HASH_INCLUDE_DIRS = ["scripts", "templates"];
export const HASH_INCLUDE_EXT = new Set([".js", ".json", ".py"]);
export const HASH_EXCLUDE_NAMES = new Set(["skill-version.json"]);

function walkFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out);
    else if (e.isFile()) out.push(full);
  }
}

/**
 * sha256 (12 hex) over a skill's behavior-defining files. Deterministic: files
 * are sorted, each contributes its skill-relative path + bytes, so a rename or a
 * content change both move the hash.
 */
export function computeSkillHash(skillDir) {
  const files = [];
  for (const d of HASH_INCLUDE_DIRS) walkFiles(path.join(skillDir, d), files);
  files.sort();
  const h = crypto.createHash("sha256");
  for (const f of files) {
    if (HASH_EXCLUDE_NAMES.has(path.basename(f))) continue;
    if (!HASH_INCLUDE_EXT.has(path.extname(f))) continue;
    h.update(path.relative(skillDir, f).split(path.sep).join("/"));
    h.update("\0");
    h.update(fs.readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

/** Walk up from a dir to find the nearest `.claude-plugin/plugin.json`. */
export function findPluginManifest(startDir) {
  let d = path.resolve(startDir);
  while (d !== path.dirname(d)) {
    const p = path.join(d, ".claude-plugin", "plugin.json");
    if (fs.existsSync(p)) return p;
    d = path.dirname(d);
  }
  return null;
}

/** Live-compute identity from the skill source (used by gen-skill-version.js). */
export function computeIdentity(skillDir) {
  const manifestPath = findPluginManifest(skillDir);
  let plugin = "unknown";
  let version = "0.0.0";
  if (manifestPath) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (m.name) plugin = m.name;
      if (m.version) version = m.version;
    } catch {}
  }
  const hash = computeSkillHash(skillDir);
  return { plugin, version, hash, id: `${plugin}@${version}+${hash}` };
}

/** Read a stamped `scripts/skill-version.json` (the published/vendored identity). */
export function readStampedIdentity(scriptsDir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(scriptsDir, "skill-version.json"), "utf8"));
    if (m && m.plugin && m.version && m.hash) {
      return { plugin: m.plugin, version: m.version, hash: m.hash, id: `${m.plugin}@${m.version}+${m.hash}` };
    }
  } catch {}
  return null;
}

/**
 * Identity a consumer should record/compare against, given its own scripts dir:
 * the stamped file if present (vendored/published), else a live compute from the
 * skill source one level up.
 */
export function currentIdentity(scriptsDir) {
  return readStampedIdentity(scriptsDir) || computeIdentity(path.dirname(scriptsDir));
}

export function formatId(id) {
  if (!id) return null;
  return typeof id === "string" ? id : `${id.plugin}@${id.version}+${id.hash}`;
}

/** A compact { plugin, version, hash } stamp for embedding in an artifact. */
export function stampOf(identity) {
  return { plugin: identity.plugin, version: identity.version, hash: identity.hash };
}
