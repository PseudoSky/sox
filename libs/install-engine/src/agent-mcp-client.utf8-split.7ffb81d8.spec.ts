/**
 * libs/install-engine/src/agent-mcp-client.utf8-split.7ffb81d8.spec.ts
 *
 * 7ffb81d8 — the agent-mcp stdio client decoded stdout chunk-by-chunk
 * (`Buffer#toString()` per `data` event), so a multi-byte UTF-8 character split
 * across two pipe chunks decoded to U+FFFD. fe155706 fixed it with a streaming
 * decoder (`child.stdout.setEncoding('utf8')`).
 *
 * Drives the REAL `AgentMcpSession` (spawn -> initialize -> tools/call -> stdout
 * line decoder -> JSON.parse) against a tiny stub child process (`node -e`) that
 * answers each `tools/call` with a JSON-RPC line written as TWO stdout chunks cut
 * at a caller-chosen byte offset. The test walks EVERY byte boundary of the
 * response line, so every position inside a 3-byte (em dash U+2014) and a 4-byte
 * (emoji U+1F600) character is covered.
 *
 * Negative control (7ffb81d8 AC2): replace `child.stdout.setEncoding('utf8')` in
 * agent-mcp-client.ts with a per-chunk `chunk.toString()` decoder; this file goes red.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { AgentMcpSession } from './agent-mcp-client.js';

/** The stub MCP server: JSON-RPC over stdio; tools/call replies are split at args.split bytes. */
const STUB_SOURCE = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeChunk = (buf) => new Promise((resolve) => process.stdout.write(buf, resolve));
rl.on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'stub', version: '0' } } }) + '\n');
    return;
  }
  const { split, text } = msg.params.arguments;
  const reply = Buffer.from(
    JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } }) + '\n',
    'utf8',
  );
  await writeChunk(reply.subarray(0, split));
  await sleep(4); // let the client's pipe reader surface the first chunk on its own
  await writeChunk(reply.subarray(split));
});
`;

const EM_DASH = '—'; // 3 bytes in UTF-8
const EMOJI = '\u{1F600}'; // 4 bytes in UTF-8
/** The tool-result payload: a JSON document whose string carries 3- and 4-byte characters. */
const PAYLOAD = { systemPrompt: `plan ${EM_DASH} act ${EMOJI} verify ${EM_DASH}${EMOJI} done`, n: 7 };
const PAYLOAD_TEXT = JSON.stringify(PAYLOAD);

/** Mirror of the stub's reply line, to know how many byte boundaries it has. */
function replyBytes(id: number): Buffer {
  return Buffer.from(
    JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: PAYLOAD_TEXT }] } }) + '\n',
    'utf8',
  );
}

const sessions: AgentMcpSession[] = [];
function newSession(): AgentMcpSession {
  const s = new AgentMcpSession({ command: process.execPath, args: ['-e', STUB_SOURCE], env: {} }, 30_000);
  sessions.push(s);
  return s;
}
afterAll(() => {
  for (const s of sessions) s.close();
});

describe('7ffb81d8 AC1: streaming UTF-8 decode of agent-mcp stdout', () => {
  it('7ffb81d8 AC1: fixture has a 3-byte and a 4-byte character', () => {
    expect(Buffer.byteLength(EM_DASH)).toBe(3);
    expect(Buffer.byteLength(EMOJI)).toBe(4);
  });

  it('7ffb81d8 AC1: result is byte-identical when the response is split at every byte boundary', async () => {
    const session = newSession();
    let interior = 0; // split offsets that land INSIDE a multi-byte character
    let checked = 0;

    // initialize takes id 1, so the k-th tool call gets id k + 1.
    for (let split = 1; ; split += 1) {
      const line = replyBytes(split + 1);
      if (split >= line.length) break;
      if (((line[split] as number) & 0xc0) === 0x80) interior += 1; // next byte is a UTF-8 continuation byte

      const result = await session.call('echo', { split, text: PAYLOAD_TEXT });

      // Byte-identical to the unsplit input, no U+FFFD anywhere.
      const got = JSON.stringify(result);
      expect(got, `split at byte ${split}`).toBe(PAYLOAD_TEXT);
      expect(got).not.toContain('�');
      expect(Buffer.from(got, 'utf8').equals(Buffer.from(PAYLOAD_TEXT, 'utf8'))).toBe(true);
      checked += 1;
    }

    // Every byte boundary was exercised, including cuts inside the multi-byte chars:
    // 2 interior cuts per em dash (x2) + 3 per emoji (x2) = 10.
    expect(checked).toBeGreaterThan(PAYLOAD_TEXT.length);
    expect(interior).toBe(10);
    expect(session.spawns).toBe(1);
  }, 60_000);

  it('7ffb81d8 AC1: an unsplit reply (control) decodes identically', async () => {
    const session = newSession();
    const result = await session.call('echo', { split: replyBytes(2).length, text: PAYLOAD_TEXT });
    expect(JSON.stringify(result)).toBe(PAYLOAD_TEXT);
  });
});
