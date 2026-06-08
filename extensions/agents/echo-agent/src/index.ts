// Agent: Echo Agent
// A stub agent that echoes inputs back using two stub tools

export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export const name = 'echo-agent';

export const description = 'A stub agent that echoes inputs back using two stub tools';

export const systemPrompt =
  'You are a helpful echo agent. When given input, you echo it back using the available tools. ' +
  'Use echo_text to return text verbatim and echo_json to return structured data.';

export const tools: Tool[] = [
  {
    name: 'echo_text',
    description: 'Echoes a text string back to the caller verbatim.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to echo back.',
        },
      },
      required: ['text'],
    },
    async execute(args) {
      const { text } = args as { text: string };
      return { echo: text };
    },
  },
  {
    name: 'echo_json',
    description: 'Accepts a JSON-serializable payload and echoes it back as structured data.',
    parameters: {
      type: 'object',
      properties: {
        payload: {
          type: 'string',
          description: 'A JSON string to parse and echo back.',
        },
      },
      required: ['payload'],
    },
    async execute(args) {
      const { payload } = args as { payload: string };
      try {
        const parsed: unknown = JSON.parse(payload);
        return { echo: parsed };
      } catch {
        return { error: 'Invalid JSON payload', raw: payload };
      }
    },
  },
];
