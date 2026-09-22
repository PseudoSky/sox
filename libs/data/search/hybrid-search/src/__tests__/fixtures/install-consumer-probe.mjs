#!/usr/bin/env node
/**
 * install-consumer-probe.mjs — imports an INSTALLED @adhd/sox-hybrid-search the
 * way a real consumer does, from a temp install tree built by
 * `install-omitted.spec.ts` (ADR-0019).
 *
 * No resolve hook, no source access: this is the registry-artifact path. It
 * proves that a `--omit=optional` install in which neither heavy native-chain
 * package is present still loads the pure surface, and that the cross-encoder
 * degrades with the named-specifier message rather than a bare module error.
 *
 * Usage: node install-consumer-probe.mjs <installed-dist-entry> [pure|cross-encoder]
 * Prints one JSON line; exits non-zero on failure.
 */
import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Synchronous fd writes: `process.exit()` would truncate piped async stdout. */
const emit = (fd, text) => writeSync(fd, `${text}\n`);
const fail = (text) => emit(2, text);

const [, , distEntry, mode = 'pure'] = process.argv;
if (!distEntry) {
  fail('usage: node install-consumer-probe.mjs <installed-dist-entry> [pure|cross-encoder]');
  process.exit(2);
}

let exitCode = 0;
try {
  const mod = await import(pathToFileURL(distEntry).href);

  if (mode === 'cross-encoder') {
    let encoderError = null;
    try {
      await mod.createCrossEncoder({ modelId: 'probe' });
      fail('createCrossEncoder unexpectedly succeeded while embedding-provider is not installed');
      exitCode = 6;
    } catch (e) {
      encoderError = { name: e?.name, message: e?.message, code: e?.code ?? null };
    }
    if (exitCode === 0) {
      emit(1, JSON.stringify({ ok: true, encoderError }));
    }
  } else {
    const fused = mod.fuse([
      { id: 1, textScore: 1 },
      { id: 2, textScore: 2 },
    ]);
    const normalized = mod.normalize([1, 2, 3], 'min_max');
    emit(1, JSON.stringify({ ok: true, fused: fused.map((r) => r.id), normalized }));
  }
} catch (err) {
  fail(`probe threw: ${err instanceof Error ? err.stack : String(err)}`);
  exitCode = 4;
}

process.exit(exitCode);
