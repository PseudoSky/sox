#!/usr/bin/env node
/**
 * mock-upstream.mjs — a fake DeepSeek upstream for testing cf-proxy logging.
 * Returns a streaming SSE response containing content + reasoning_content
 * deltas and a usage trailer with completion_tokens_details.reasoning_tokens.
 */
import http from 'node:http';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const reqData = JSON.parse(body || '{}');
    const tokens = reqData.max_tokens || 100;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });

    const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    // reasoning deltas (the decision trail)
    for (const frag of ['I must decide: patch', ' or own the emitted', ' template.']) {
      emit({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: frag } }] });
    }
    // content deltas
    for (const frag of ['Writing the spec.', ' Approach: canonical.', ' Done.']) {
      emit({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: frag } }] });
    }
    // usage trailer
    emit({
      id: 'mock', object: 'chat.completion.chunk', choices: [],
      usage: {
        prompt_tokens: 123, completion_tokens: 456,
        prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: 73,
        completion_tokens_details: { reasoning_tokens: 200 },
      },
    });
    emit({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

const PORT = process.env.MOCK_PORT || 3399;
server.listen(PORT, () => console.log(`mock upstream on :${PORT}`));
