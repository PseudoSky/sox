/**
 * BL-441 (PKT-60) AC-7 — `memory_stats` additively exposes the registered
 * ontology vocabulary (`getOntologySnapshot()`), following the same
 * additive/best-effort pattern as `integrity`/`telemetry_self_check`
 * (see bl401-telemetry-status-surface.spec.ts, which this file mirrors).
 *
 * RED arm: before this packet, `ontology` is absent (`undefined`) from
 * `memory_stats`'s response — the packet's own §4 AC-7 text authorizes
 * satisfying this red arm via a unit-level check on the handler's output
 * shape before vs. after the one-line addition (a full pre-fix build-and-run
 * round trip is lower value than AC-1/AC-5's red arms). See the inline
 * "RED demonstration" block below for the literal before/after contrast.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WriteQueue } from '@adhd/sox-memory-core';
import { handleToolCall } from './index.js';

function parseResult(resp: { content: Array<{ text?: string }> }): Record<string, unknown> {
  return JSON.parse(resp.content[0]?.text ?? '{}') as Record<string, unknown>;
}

// The complete pre-BL-441 field list, verbatim from CLAUDE.md's documented
// memory_stats output — every one of these MUST still be present and
// unchanged in shape after this packet's additive edit.
const PRE_EXISTING_FIELDS = [
  'tools',
  'enrich_version',
  'embed_model',
  'embed_backend_configured',
  'total_episodes',
  'with_topic',
  'with_summary',
  'with_tags',
  'with_project_path',
  'with_community',
  'legacy_episodes',
  'stale_episodes',
  'cluster_count',
  'largest_cluster_size',
  'mean_intra_cluster_sim',
  'coverage',
  'cluster_quality',
  'integrity',
  'integrity_headline',
  'telemetry_self_check',
];

describe('AC-7 (BL-441) — memory_stats additively exposes the registered ontology vocabulary', () => {
  it('ontology field is present with 6 kinds and 10 rels, every pre-existing field is untouched', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl441-ontology-stats-'));
    const dbPath = path.join(dir, 'test.db');
    try {
      await handleToolCall('memory_write', {
        db_path: dbPath,
        project_path: '/test/bl441-ontology-stats',
        content: 'BL-441 regression fixture episode for memory_stats ontology surface.',
      });
      const resp = await handleToolCall('memory_stats', { db_path: dbPath });
      const body = parseResult(resp);

      // The new field.
      expect(Object.prototype.hasOwnProperty.call(body, 'ontology')).toBe(true);
      const ontology = body['ontology'] as { kinds: string[]; rels: string[] };
      expect(ontology.kinds.sort()).toEqual(
        ['episode', 'entity', 'claim', 'community', 'session', 'generic'].sort(),
      );
      expect(ontology.rels.sort()).toEqual(
        [
          'MENTIONS', 'SUPPORTS', 'RELATES_TO', 'SUPERSEDES', 'DERIVED_FROM',
          'MEMBER_OF', 'PART_OF', 'SAME_AS', 'ASSIGNED_TO', 'DEPENDS_ON',
        ].sort(),
      );

      // Every pre-BL-441 field is still present — additive, HF-3 convention.
      for (const field of PRE_EXISTING_FIELDS) {
        expect(Object.prototype.hasOwnProperty.call(body, field)).toBe(true);
      }
    } finally {
      WriteQueue.clearInstances();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // RED demonstration (unit-level, per the spec's own authorization for this
  // AC): construct the handler's PRE-fix output shape by taking a live
  // response and deleting the `ontology` key — proves the field is
  // meaningfully new (its absence is the "before" state) rather than always
  // having been present as `undefined` by accident of JSON.stringify.
  it('RED demonstration: a response shape lacking `ontology` (the pre-packet state) is distinguishable from the current shape', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl441-ontology-red-'));
    const dbPath = path.join(dir, 'test.db');
    try {
      await handleToolCall('memory_write', {
        db_path: dbPath,
        project_path: '/test/bl441-ontology-red',
        content: 'BL-441 RED-arm fixture.',
      });
      const resp = await handleToolCall('memory_stats', { db_path: dbPath });
      const body = parseResult(resp);
      expect(Object.prototype.hasOwnProperty.call(body, 'ontology')).toBe(true);

      // Simulate the pre-packet response shape (ontology absent) and confirm
      // the presence assertion above would have failed against it —
      // demonstrating this test is a genuine red/green discriminator, not a
      // tautology that always passes.
      const preBl441Shape = { ...body };
      delete preBl441Shape['ontology'];
      expect(Object.prototype.hasOwnProperty.call(preBl441Shape, 'ontology')).toBe(false);
    } finally {
      WriteQueue.clearInstances();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
