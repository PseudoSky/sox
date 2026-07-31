// Fixture for the no-hook-assigned-skip rule. This is the exact shape that made
// recall-parity.test.ts and heal-backend-agnostic.test.ts skip forever.
import { beforeAll, describe, it } from 'vitest';

async function available(): Promise<boolean> { return true; }

describe('frozen skip fixture', () => {
  let hasThing = false;
  beforeAll(async () => { hasThing = await available(); });
  it('never runs', { skip: !hasThing }, async () => { /* ... */ });
});
