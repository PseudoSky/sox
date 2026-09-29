/**
 * drain-wake-fake-enrich-host.cjs — BL-474 test fixture, forked-child side.
 *
 * A trivial stand-in for `enrich-process-host.js`, used ONLY by the BL-474
 * "heal-vs-heal exclusion... via YIELD not WAIT" test in drain-wake.spec.ts.
 *
 * WHY THIS EXISTS: that test's load-bearing assertion is that the enrich
 * tick's HEAL step (`withBackgroundSlotOrSkip`) resolves fast — it races
 * `runEnrichPassOnDb` against a 500ms timer to prove the heal step yields
 * instead of blocking on the drain's held slot. But `runEnrichPassOnDb`
 * doesn't return until AFTER the heal step, once it has also forked and
 * awaited the REAL `enrich-process-host.js` child (BL-348 isolation) for the
 * clustering pass — work the heal-vs-heal assertion never touches. Under
 * machine load that real fork (loading better-sqlite3 natives, opening its
 * own DB connection, etc.) measured 227-1784ms, well past the 500ms budget,
 * making the test flaky for a reason unrelated to the invariant it guards.
 *
 * This fixture removes that unrelated variance: it is forked in the real
 * heal step's place via `_setEnrichHostForkResolverForTest`, requires
 * nothing beyond node core, and replies over IPC immediately with a
 * trivially-successful, no-op BatchEnrichResult — never touching the DB at
 * all. The heal-vs-heal timing the test actually asserts is untouched; only
 * the irrelevant child-process clustering work is now near-instant.
 *
 * Protocol mirrors enrich-process-host.ts exactly (see that file's own
 * header): request `{ id, dbPath, opts }` in, response `{ id, result }` or
 * `{ id, error }` out, then exit.
 */

process.on('message', (req) => {
  const result = {
    communities_upserted: 0,
    member_of_edges: 0,
    importance_updated: 0,
    relates_to_edges: 0,
    topics_backfilled: 0,
    legacy_nodes_stamped: 0,
    embed_model_backfilled: 0,
    cluster_pass_skipped: true,
    cluster_pass_skip_reason: 'drain-wake-fake-enrich-host fixture — no real clustering performed',
  };
  if (typeof process.send === 'function') {
    process.send({ id: req.id, result });
  }
  setImmediate(() => process.exit(0));
});
