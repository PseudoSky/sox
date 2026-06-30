// ── Error taxonomy ──────────────────────────────────────────────────────────

export class ModelNotLoadedError extends Error {
  constructor(message: string, public readonly modelId: string) {
    super(message);
    this.name = 'ModelNotLoadedError';
  }
}

export class VerifierBusyError extends Error {
  constructor(message: string, public readonly retryAfterMs?: number) {
    super(message);
    this.name = 'VerifierBusyError';
  }
}

export class UnsupportedLanguageError extends Error {
  constructor(message: string, public readonly language: string) {
    super(message);
    this.name = 'UnsupportedLanguageError';
  }
}

export class PreFilterSkippedError extends Error {
  constructor(message: string, public readonly score: number, public readonly threshold: number) {
    super(message);
    this.name = 'PreFilterSkippedError';
  }
}

export class InvalidClaimInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidClaimInputError';
  }
}
