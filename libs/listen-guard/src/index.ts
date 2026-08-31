/**
 * libs/listen-guard/src/index.ts — @adhd/sox-listen-guard public API.
 *
 * Repo-wide listen() safety invariant (BL-619): probe-before-bind + guarded
 * listen + structured JSONL failure records, adopted by every production listen
 * site. Dependency-free leaf (node builtins only: net, fs, path).
 */

export {
  probeTcp,
  classifyListenError,
  buildFailureRecord,
  emitListenFailure,
  listenGuarded,
} from './listen-guard.js';
export type {
  ListenDisposition,
  ListenFailureRecord,
  ListenTarget,
  ListenGuardOptions,
  EmitFailureOptions,
  ListenOutcome,
} from './listen-guard.js';
