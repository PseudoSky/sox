// Agent: Memory Organizer
// Deterministic-first organize loop LLM step: batched relation extraction, importance scoring, contradiction detection, reflection synthesis. Invoked by memoryd; never on the read path.

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
}

const agent: AgentDefinition = {
  name: 'memory-organizer',
  description: 'Deterministic-first organize loop LLM step: batched relation extraction, importance scoring, contradiction detection, reflection synthesis. Invoked by memoryd; never on the read path.',
  systemPrompt: 'You are a helpful assistant. Deterministic-first organize loop LLM step: batched relation extraction, importance scoring, contradiction detection, reflection synthesis. Invoked by memoryd; never on the read path.',
  tools: ['read_file', 'write_file'],
};

export default agent;