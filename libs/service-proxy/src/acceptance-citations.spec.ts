/**
 * acceptance-citations.spec.ts — 8468f7b1 SP27 and SP32 acceptance-criteria citations.
 *
 * SP6 lives in connection-identity.sp6.spec.ts (it binds a real UDS, so it is in the quarantined
 * lane). This file is pure file reads: no sockets, no child processes, no git.
 *
 * SP27 (regression gate): the 15 spec files that existed at the 0.5.0 base commit 54871159 are
 * unchanged. Asserted against a committed sha256 manifest (portable: no git or reachable commit
 * needed). Changing one of these files on purpose means updating this manifest in the same
 * commit, which is exactly the review signal the gate exists to raise.
 *
 * SP32 (docs): README documents the lifecycle primitives and api-stability.md records the 0.6.0
 * additions.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const PKG_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..');

/** sha256 of each base-commit (54871159) spec file; `rg -c "^\s*(it|test)\("` base total is 102. */
const BASE_SPEC_SHA256: ReadonlyArray<readonly [string, string]> = [
  ['4041c6e0-uds-dir-ownership.spec.ts', '2e8a11e5e9e63683c4a6c66d95e3de25910d231db70a5f0945cefabb97ca88af'],
  ['4041c6e0-umask-002-tighten.spec.ts', '1d0dfcebf15e6f3078764993a539e9e2211722d42a1241ef6295f97108318e13'],
  ['448f9d93-close-does-not-unlink-successor.spec.ts', 'd07c11d06592713bcb5ac5b4774b8ebf75e66d359420445703138c69cf289413'],
  ['backend.spec.ts', '50d321650dae261d031bd59dcdba9d17bdf5b76e4c3e622da55c0709afe9b6c6'],
  ['dial-flush-ordering.bl-6b4ff2b8.spec.ts', 'c9863b36a78a2345c7cacb3d11c7c392c7575f7e0accde609fd16cef9a3393f0'],
  ['dial-flush-writable-check.bl-6b4ff2b8.spec.ts', '322987ded0453eaad2bd6e46576ccaacc03dbfb0d420e22835ac08ced74dee83'],
  ['dial-flush-yields.bl-6b4ff2b8.spec.ts', 'a44069fd8fbc14f630964eae34fc0de1ab025697cf9b9aaa5e3321bdc6ef7789'],
  ['dial-unref.spec.ts', 'dabaa87f352fd685157207b4880200db9473412595ffd93eabe517d77a1ec37f'],
  ['dial.spec.ts', 'f53ee2d14be93eb075fe29fc69a29523ba2cad31bbf6ef9e0efa739d08004b53'],
  ['ensure-backend-await-survives.spec.ts', 'c779c6d66858951acba2cf298418823a6fc4442a35640e5f74abb706f3a98c41'],
  ['ensure-backend.spec.ts', 'aa0e71ed9003fdc00530c17fd10dbe1ad566985997959af35737771db2c22c46'],
  ['framing.spec.ts', '77bf3a1e05bd9916d4e1f67e15008b394607d43bdd234e447bd0d280a339d45b'],
  ['schema-hash.spec.ts', 'e40003045e45ad669d0ad859206afac44605afdcd22621ce952ac5f6dfa4c39d'],
  ['shim.spec.ts', '56c85551c3c9c9f75222ace122119b68590e6eb332a416af679a8992c762dede'],
  ['socket-path.spec.ts', '71df02e342350fb09f2388db0b7aab21ca368da4b4489c9c35b35143ebede2d0'],
];

describe('8468f7b1 SP27 regression gate: the 0.5.0 base specs are unchanged', () => {
  it('8468f7b1 SP27 the manifest lists exactly the 15 base spec files', () => {
    expect(BASE_SPEC_SHA256).toHaveLength(15);
    expect(new Set(BASE_SPEC_SHA256.map(([n]) => n)).size).toBe(15);
  });

  it.each(BASE_SPEC_SHA256)('8468f7b1 SP27 %s exists and is byte-identical to the base', (name, sha) => {
    const file = path.join(PKG_ROOT, 'src', name);
    expect(fs.existsSync(file), `${name} was deleted or renamed`).toBe(true);
    const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    expect(actual, `${name} was modified; the 0.5.0 specs must stay untouched`).toBe(sha);
  });
});

describe('8468f7b1 SP32 docs: README and api-stability record the 0.6.0 lifecycle primitives', () => {
  const readme = fs.readFileSync(path.join(PKG_ROOT, 'README.md'), 'utf8');
  const stability = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'publishing', 'api-stability.md'), 'utf8');

  it('8468f7b1 SP32 README has a "Lifecycle primitives" section with the ADR-0022 rule box', () => {
    expect(readme).toMatch(/^## Lifecycle primitives \(0\.6\.0\)$/m);
    expect(readme).toMatch(/The ADR-0022 rule: presence never pins/);
  });

  it.each(['createIdleRetirer', 'createCircuitBreaker', 'ctx.connectionId', 'onClientConnect', 'readProcessStartToken', 'startToken'])(
    '8468f7b1 SP32 README documents %s inside the Lifecycle primitives section',
    (symbol) => {
      const start = readme.indexOf('## Lifecycle primitives (0.6.0)');
      expect(start).toBeGreaterThanOrEqual(0);
      const rest = readme.slice(start + 4);
      const next = rest.search(/^## /m);
      const section = next === -1 ? rest : rest.slice(0, next);
      expect(section, `${symbol} missing from the README lifecycle section`).toContain(symbol);
    },
  );

  it('8468f7b1 SP32 api-stability.md has the 0.6.0 additions table naming every primitive', () => {
    const start = stability.indexOf('### `@adhd/sox-service-proxy` 0.6.0 additions');
    expect(start, '0.6.0 additions heading missing').toBeGreaterThanOrEqual(0);
    const rest = stability.slice(start + 4);
    const next = rest.search(/^#{1,3} /m);
    const section = next === -1 ? rest : rest.slice(0, next);
    expect(section).toMatch(/\| Addition \| Exports \|/);
    for (const symbol of [
      'ConnectionContext',
      'ClientDisconnectReason',
      'onClientConnect',
      'onClientDisconnect',
      'readProcessStartToken',
      'isSameProcess',
      'startToken',
      'createIdleRetirer',
      'idleDueInMs',
      'createCircuitBreaker',
    ]) {
      expect(section, `${symbol} missing from the api-stability 0.6.0 table`).toContain(symbol);
    }
    expect(section).toMatch(/experimental until 1\.0/);
  });
});
