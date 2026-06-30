// ── Claim normalizer ────────────────────────────────────────────────────────

export interface ClaimNormalizer {
  normalizeClaim(text: string): string;
  normalizeSource(text: string): string;
}

export class DefaultClaimNormalizer implements ClaimNormalizer {
  normalizeClaim(text: string): string {
    return this.normalizeWhitespace(
      this.removeQuotes(
        this.stripCitationMarkers(text),
      ),
    );
  }

  normalizeSource(text: string): string {
    return this.normalizeWhitespace(this.removeQuotes(text));
  }

  private normalizeWhitespace(text: string): string {
    return text.trim().replace(/\s+/g, ' ');
  }

  private stripCitationMarkers(text: string): string {
    return text
      .replace(/\s*\[\d+(?:,\s*\d+)*\]/g, '')
      .replace(/\s*\(p\.\s*\d+\)/g, '')
      .replace(/\s*\([A-Za-zÀ-ÿ]+ et al\.,\s*\d{4}\)/g, '')
      .replace(/\s*\{id:\s*[a-zA-Z0-9]+\}/g, '');
  }

  private removeQuotes(text: string): string {
    return text
      .replace(/[\u201C\u201D]/g, '')
      .replace(/[\u2018\u2019]/g, '')
      .replace(/["']/g, '');
  }
}
