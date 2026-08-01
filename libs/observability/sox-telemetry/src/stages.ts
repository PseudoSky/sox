/**
 * stages.ts — `declareStages` + `withContendedStage`, the BL-351 §5.2/§5.3
 * anti-convention primitives.
 *
 * Two structural guarantees, both enforced at compile time under `strict`:
 *
 * 1. **Wait cannot be recorded without work, or vice versa.** There is no
 *    function that records only one. `withContendedStage` measures wait from
 *    the call to admission, work from admission to completion, and always
 *    emits both `sox.stage.wait_ms` and `sox.stage.work_ms` as a pair.
 * 2. **Stages and their code paths are a closed union, declared once per
 *    package.** `withContendedStage(catalog, 'embed_heal', ...)` on an
 *    undeclared stage is a TypeScript compile error — you cannot invent a
 *    stage name at a call site and therefore cannot silently create a second,
 *    differently-named metric for a sibling path (the exact BL-319 defect:
 *    an instrument wired to one of two code paths is indistinguishable from
 *    no instrument).
 */

import { performance } from 'node:perf_hooks';
import { _emitRecord, _recordStageDuration, _recordStageOutcome, _registerStageDeclaration } from './runtime.js';

export interface StageDeclaration {
  /** Named code paths that can enter this stage. `telemetrySelfCheck()`
   *  reports, per path, whether it has ever produced a sample — this is what
   *  makes an unwired sibling path (BL-319) a visible, machine-readable
   *  finding instead of a silent zero. */
  paths: readonly string[];
}

export type StageMap = Record<string, StageDeclaration>;

export class StageCatalog<T extends StageMap> {
  private readonly _key: string;

  constructor(
    public readonly pkg: string,
    public readonly stages: T,
  ) {
    this._key = pkg;
    for (const [name, decl] of Object.entries(stages)) {
      _registerStageDeclaration(`${pkg}.${name}`, pkg, decl.paths);
    }
  }

  private stageKey<K extends keyof T & string>(stage: K): string {
    return `${this._key}.${stage}`;
  }

  /**
   * The ONLY way to enter a contended resource under this catalog. `admit`
   * is the blocking part (queue slot, lock, semaphore); `work` is the
   * compute part. Emits, always paired:
   *
   *   sox.stage.wait_ms   (histogram)  { package, stage, path, phase: 'wait' }
   *   sox.stage.work_ms   (histogram)  { package, stage, path, phase: 'work' }
   *   sox.stage.count     (counter)    { package, stage, path, outcome }
   */
  async withContendedStage<K extends keyof T & string, R>(
    stage: K,
    stagePath: T[K]['paths'][number],
    admit: () => Promise<void>,
    work: () => Promise<R>,
  ): Promise<R> {
    const key = this.stageKey(stage);
    const waitStart = performance.now();
    _recordStageOutcome(key, stagePath, 'started');
    _emitRecord(`sox.stage.${stage}.start`, 'info', {
      sox_package: this.pkg,
      sox_stage: stage,
      sox_path: stagePath,
      sox_phase: 'wait',
    });

    await admit();
    const waitMs = Math.round(performance.now() - waitStart);
    _recordStageDuration(key, 'wait', waitMs);
    _emitRecord(`sox.stage.${stage}.admitted`, 'info', {
      sox_package: this.pkg,
      sox_stage: stage,
      sox_path: stagePath,
      sox_phase: 'wait',
      wait_ms: waitMs,
    });

    const workStart = performance.now();
    try {
      const result = await work();
      const workMs = Math.round(performance.now() - workStart);
      _recordStageDuration(key, 'work', workMs);
      _recordStageOutcome(key, stagePath, 'finished');
      _emitRecord(`sox.stage.${stage}.finish`, 'info', {
        sox_package: this.pkg,
        sox_stage: stage,
        sox_path: stagePath,
        sox_phase: 'work',
        wait_ms: waitMs,
        work_ms: workMs,
      });
      return result;
    } catch (err) {
      const workMs = Math.round(performance.now() - workStart);
      _recordStageDuration(key, 'work', workMs);
      _recordStageOutcome(key, stagePath, 'error');
      _emitRecord(`sox.stage.${stage}.error`, 'error', {
        sox_package: this.pkg,
        sox_stage: stage,
        sox_path: stagePath,
        sox_phase: 'work',
        wait_ms: waitMs,
        work_ms: workMs,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

/** Declare a package's stage inventory once. `StageId` for that package is
 *  derived from the returned catalog's keys — there is no way to reference a
 *  stage name that was not declared here. */
export function declareStages<T extends StageMap>(pkg: string, stages: T): StageCatalog<T> {
  return new StageCatalog(pkg, stages);
}
