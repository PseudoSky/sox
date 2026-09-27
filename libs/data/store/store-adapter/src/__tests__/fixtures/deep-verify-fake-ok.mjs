/**
 * (BL-fc5ab895) Fake deep verifier that completes `ok` immediately. It still
 * honours the real contract: parses `--payload`, replies once over IPC with a
 * validated `pragma_integrity_check` finding, then exits 0. When
 * DEEP_VERIFY_FAKE_TOUCH is set it appends one line per run to that file, so a
 * test can count how many verifier runs actually happened.
 */
import { appendFileSync } from 'node:fs';

const i = process.argv.indexOf('--payload');
const payload = JSON.parse(process.argv[i + 1]);
if (process.env.DEEP_VERIFY_FAKE_TOUCH) {
  appendFileSync(process.env.DEEP_VERIFY_FAKE_TOUCH, `${process.pid} ${payload.dbPath}\n`);
}
process.send(
  {
    type: 'result',
    findings: [
      {
        probe: 'pragma_integrity_check',
        object: 'main',
        status: 'ok',
        detail: 'fake verifier: integrity_check clean.',
        repairable: false,
        backlog: 'BL-341',
        probeValidated: true,
        truncated: false,
      },
    ],
    duration_ms: 1,
    query_only: 1,
  },
  (err) => {
    if (err) process.stderr.write(`fake verifier send failed: ${err.message}\n`);
    process.exit(0);
  },
);
