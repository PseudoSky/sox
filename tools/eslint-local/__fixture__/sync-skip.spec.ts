// Negative control for no-hook-assigned-skip: availability resolved
// synchronously at module load. The rule must NOT fire here.
import * as fs from 'node:fs';
import { beforeAll, describe, it } from 'vitest';

const HAS_THING = fs.existsSync('/some/driver/path');

describe('sync skip fixture', () => {
  beforeAll(async () => { /* unrelated setup */ });
  it('actually runs when the driver is present', { skip: !HAS_THING }, async () => { /* ... */ });
});
