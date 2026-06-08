// MCP Server: Agent Memory Server
// 7 memory_* tools over a single-file SQLite graph store: hybrid recall (<50ms, zero LLM), write-enqueue, session state, communities, invalidation.
// Transport: stdio

import { createInterface } from 'node:readline';

const tools = [
  {
    name: 'example_tool',
    description: 'A stub tool for memory-server',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
];

async function handleRequest(req: unknown): Promise<unknown> {
  const r = req as { method: string; id?: unknown };
  if (r.method === 'tools/list') return { tools };
  if (r.method === 'tools/call') return { content: [{ type: 'text', text: 'stub response' }] };
  return { error: { code: -32601, message: 'Method not found' } };
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  try {
    const req = JSON.parse(line) as unknown;
    const res = await handleRequest(req);
    process.stdout.write(JSON.stringify(res) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: String(e) }) + '\n');
  }
});