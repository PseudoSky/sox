/**
 * baseline-capture — dev tooling (BL-164 promotion; see per-module headers for the
 * BL-160-precedent rationale). Not a shipped/published package: consumed only via
 * direct node invocation of `dist/capture-*.js` or the `baseline-capture:capture-*`
 * nx targets.
 */

export {
  captureEnrichmentBaseline,
  runEnrichmentBaselinePass,
  buildEnrichmentBaseline,
  DEFAULT_BATCH_ENRICH_OPTIONS,
} from './capture-enrichment-baseline.js';
export type {
  CaptureEnrichmentBaselineOptions,
  CaptureEnrichmentBaselineResult,
  EnrichmentBaseline,
  EnrichmentPassCounts,
} from './capture-enrichment-baseline.js';

export {
  captureWritePerfBaseline,
  computeWritePerfMeasurements,
  buildWritePerfBaseline,
  percentile,
} from './capture-write-perf-baseline.js';
export type {
  CaptureWritePerfBaselineOptions,
  CaptureWritePerfBaselineResult,
  WritePerfBaseline,
  WritePerfMeasurements,
} from './capture-write-perf-baseline.js';
