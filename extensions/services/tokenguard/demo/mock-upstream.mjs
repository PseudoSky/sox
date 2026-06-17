#!/usr/bin/env node
/**
 * mock-upstream.mjs — [fix:mock-upstream]
 *
 * Tiny stand-in HTTP upstream that:
 *   1. Receives the (tokenized) request body.
 *   2. Echoes it back as a minimal Anthropic-style SSE stream in two deltas
 *      (so the demo proves split-token reassembly as well as straight reversal).
 *   3. Writes the received body to OUT_DIR/received-body.json so the demo can
 *      inspect what arrived on the wire.
 *
 * Invoked as:
 *   node demo/mock-upstream.mjs <port> <out_dir>
 *
 * Exits after the first request (single-shot for demo harness).
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = parseInt(process.argv[2] ?? '19099', 10);
const OUT_DIR = process.argv[3] ?? '/tmp/tokenguard-demo-out';

fs.mkdirSync(OUT_DIR, { recursive: true });

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');

    // Persist the received (tokenized) body for the demo audit
    fs.writeFileSync(path.join(OUT_DIR, 'received-body.json'), body, 'utf8');

    // Extract the first message content string to echo back in SSE form.
    // We stream the word back split across two deltas to prove SSE reassembly.
    let echoText = 'mock-reply';
    try {
      const parsed = JSON.parse(body);
      const msgs = parsed.messages;
      if (Array.isArray(msgs) && msgs.length > 0) {
        const first = msgs[0];
        if (first && typeof first.content === 'string') {
          echoText = first.content.slice(0, 80);
        } else if (first && Array.isArray(first.content)) {
          const textBlock = first.content.find(b => b.type === 'text');
          if (textBlock?.text) echoText = textBlock.text.slice(0, 80);
        }
      }
    } catch {
      // non-JSON — use default echo
    }

    // Split echoText across two deltas (mid-point) to prove reassembly
    const mid = Math.max(1, Math.floor(echoText.length / 2));
    const part1 = echoText.slice(0, mid);
    const part2 = echoText.slice(mid);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Transfer-Encoding': 'chunked',
    });

    // Anthropic SSE stream shape
    const events = [
      { type: 'message_start', message: { id: 'mock-msg', type: 'message', role: 'assistant', content: [], model: 'mock', stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part1 } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part2 } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } },
      { type: 'message_stop' },
    ];

    for (const ev of events) {
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    }
    res.end();

    // Exit after first request — single-shot for demo
    server.close(() => process.exit(0));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`mock-upstream: listening on http://127.0.0.1:${PORT}\n`);
});
