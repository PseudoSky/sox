import { ingest } from '@adhd/sox-ingest';

export function extractiveSummary(content: string): string {
  if (content.length < 100) return content;
  return ingest(content, { summaryMaxSentences: 2 }).summary;
}
