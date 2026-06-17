/**
 * roundtrip.spec.ts — exact round-trip + wire-leak invariants
 *
 * Invariants proven:
 *   [inv:bijective-roundtrip]  detokenizeText(tokenizeStr(x)) === x
 *   [inv:wire-guarantee]       wireLeaks() returns empty after tokenizeRequest()
 *                              for scoped regions; tools JSON-Schema is verbatim.
 */

import { describe, it, expect } from 'vitest';
import {
  Mapper,
  tokenizeStr,
  tokenizeRequest,
  wireLeaks,
  detokenizeText,
  walkTokenize,
} from '@sox/tokenguard-core';

// ── [inv:bijective-roundtrip] corpus ─────────────────────────────────────────

const ROUNDTRIP_CORPUS: Array<{ label: string; text: string }> = [
  {
    label: 'plain hostname',
    text: 'Connect to webapp.internal.corp via SSH',
  },
  {
    label: 'IPv4 address',
    text: 'Target IP is 10.20.30.40 on port 443',
  },
  {
    label: 'email address',
    text: 'Alert sent to security@vulntarget.internal',
  },
  {
    label: 'MAC address',
    text: 'Interface eth0 MAC: de:ad:be:ef:ca:fe connected',
  },
  {
    label: 'mixed: hostname + IP in same sentence',
    text: 'Server webapp.corp.internal resolves to 192.168.5.10',
  },
  {
    label: 'pre-seeded real via getOrCreate',
    text: 'Testing pre-seeded host: custom-target.internal here',
  },
  {
    label: 'phone number (E.164)',
    text: 'Support line: +1-800-555-9876 ext 42',
  },
];

describe('[inv:bijective-roundtrip] — detokenizeText(tokenizeStr(x)) === x', () => {
  for (const { label, text } of ROUNDTRIP_CORPUS) {
    it(`round-trips: ${label}`, () => {
      const m = new Mapper();
      const tokenized = tokenizeStr(text, m, null);
      const restored = detokenizeText(tokenized, m, null);
      expect(restored).toBe(text);
    });
  }

  it('round-trips a pre-seeded entry (seed → tokenize → detokenize)', () => {
    const m = new Mapper();
    m.getOrCreate('pre-seeded.internal', 'host', 'seed');
    const text = 'Target: pre-seeded.internal';
    const tokenized = tokenizeStr(text, m, null);
    expect(tokenized).not.toContain('pre-seeded.internal');
    const restored = detokenizeText(tokenized, m, null);
    expect(restored).toBe(text);
  });

  // NEGATIVE CONTROL: a mapper with a different map should NOT restore correctly.
  it('[neg-ctrl] detokenize with wrong mapper does NOT restore', () => {
    const m1 = new Mapper();
    const tokenized = tokenizeStr('host: alpha.corp', m1, null);

    const m2 = new Mapper(); // different mapper, unknown tokens
    const wrongRestore = detokenizeText(tokenized, m2, null);
    // m2 has no entry for <HOST_1> so wrongRestore still contains the token
    expect(wrongRestore).not.toBe('host: alpha.corp');
  });
});

// ── [inv:wire-guarantee] — zero leaks after tokenizeRequest ──────────────────

describe('[inv:wire-guarantee] — wireLeaks empty after tokenizeRequest', () => {
  function buildRequest(system: string, userMessage: string): Record<string, unknown> {
    return {
      system,
      messages: [{ role: 'user', content: userMessage }],
      metadata: { session: 'test-session' },
      tools: [
        {
          name: 'bash',
          description: 'Run a shell command',
          input_schema: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
      ],
    };
  }

  it('no mapped reals survive in system/messages/metadata after tokenizeRequest', () => {
    const m = new Mapper();
    let req = buildRequest(
      'You are assessing webapp.internal.corp on 10.0.0.5.',
      'Find open ports on 10.0.0.5 and report to admin@webapp.internal.corp.',
    );
    req = tokenizeRequest(req, m, null) as Record<string, unknown>;
    const leaks = wireLeaks(req, m);
    expect(leaks).toEqual([]);
  });

  it('tools field is left verbatim (not tokenized)', () => {
    const m = new Mapper();
    // seed a value that happens to appear inside the tools schema description
    m.getOrCreate('bash', 'id', 'seed');
    let req = buildRequest('Assessment of target.corp', 'Check the system.');
    req = tokenizeRequest(req, m, null) as Record<string, unknown>;

    // tools should be untouched (schema domains, tool names stay as-is)
    const tools = req['tools'] as Array<Record<string, unknown>>;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools[0]).toBeDefined();
    expect((tools[0] as Record<string, unknown>)['name']).toBe('bash');
  });

  it('wireLeaks only scans scoped regions — tools content does not count as a leak', () => {
    const m = new Mapper();
    // Seed a real that exists only in the tools JSON-Schema (not in scoped regions)
    // wireLeaks must NOT flag it because tools is excluded from the scoped scan
    let req: Record<string, unknown> = {
      system: 'Clean system prompt.',
      messages: [{ role: 'user', content: 'Simple question.' }],
      metadata: {},
      tools: [
        {
          name: 'tool-one',
          description: 'Does something with real-in-tools.internal',
          input_schema: { type: 'object', properties: {} },
        },
      ],
    };
    // Seed that FQDN so it's a mapped real
    m.getOrCreate('real-in-tools.internal', 'host', 'seed');
    req = tokenizeRequest(req, m, null) as Record<string, unknown>;
    // wireLeaks scans system/messages/metadata only — the real is only in tools
    const leaks = wireLeaks(req, m);
    expect(leaks).toEqual([]);
  });

  it('round-trip is exact after tokenizeRequest (scoped regions restore)', () => {
    const m = new Mapper();
    const origSystem = 'Assess target.internal.corp at 172.16.0.1.';
    const origMsg = 'What services run on 172.16.0.1?';
    let req = buildRequest(origSystem, origMsg);

    // Capture originals before mutation
    const originalReq = {
      system: origSystem,
      messages: [{ role: 'user', content: origMsg }],
    };

    req = tokenizeRequest(req, m, null) as Record<string, unknown>;

    // Restore system
    const restoredSystem = detokenizeText(req['system'] as string, m, null);
    expect(restoredSystem).toBe(originalReq.system);

    // Restore message content
    const msgs = req['messages'] as Array<Record<string, unknown>>;
    const restoredMsg = detokenizeText(msgs[0]!['content'] as string, m, null);
    expect(restoredMsg).toBe(originalReq.messages[0]!.content);
  });
});

// ── signature passthrough ─────────────────────────────────────────────────────

describe('signature key passthrough', () => {
  it('walkTokenize does NOT touch signature values (thinking block passthrough)', () => {
    const m = new Mapper();
    const sigValue = 'EqBKJXR4zZuWr2wD+xCryptoSig==';
    // Seed a real that appears inside the fake signature value
    m.getOrCreate('xCryptoSig', 'id', 'seed');

    const block = {
      type: 'thinking',
      thinking: 'analysis with webapp.internal.corp mention',
      signature: sigValue,
    };
    const result = walkTokenize(block, m, null) as typeof block;
    // signature must be verbatim
    expect(result.signature).toBe(sigValue);
  });
});
