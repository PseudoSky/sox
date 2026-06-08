/**
 * provider-capabilities.ts — Static capability matrix query
 *
 * Contract (Section 2, Gap 5):
 *   Given a model string and an extension's requires block,
 *   look up the model in the vendored capability table and return
 *   { ok: boolean, warnings: string[] } covering:
 *     - tool_calling
 *     - structured_output
 *     - min_context_tokens
 *
 *   Side effects: none — pure (reads assets/model_capabilities.json at load time).
 *   Source: multi-llm-provider-abstraction.md §3; migration.md Section 2 + Gap 5.
 *
 * Gap 5 decision (advisory-warn default, hard-block opt-in):
 *   This function returns warnings; install.ts decides whether to hard-block
 *   based on strict_capabilities:true. This function is NEVER the authority
 *   on blocking — it only reports capability mismatches.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');
const CAPABILITIES_PATH = path.join(ASSETS_DIR, 'model_capabilities.json');

export interface RequiresBlock {
  tool_calling?: boolean | undefined;
  structured_output?: boolean | undefined;
  min_context_tokens?: number | undefined;
}

export interface CapabilityResult {
  ok: boolean;
  warnings: string[];
}

export interface ModelCapabilityEntry {
  supports_function_calling?: boolean;
  supports_tool_choice?: boolean;
  supports_response_schema?: boolean;
  max_input_tokens?: number;
  max_tokens?: number;
  // LiteLLM uses various field names; we handle both
  tool_calling?: boolean;
  function_calling?: boolean;
  structured_output?: boolean;
}

type CapabilityTable = Record<string, ModelCapabilityEntry>;

let _capTable: CapabilityTable | null = null;

function loadCapabilityTable(): CapabilityTable {
  if (_capTable) return _capTable;
  if (!fs.existsSync(CAPABILITIES_PATH)) {
    // No capability table vendored yet — return empty (all checks pass with warning)
    console.warn(
      `provider-capabilities: WARNING no capability table at ${CAPABILITIES_PATH}. ` +
        `All capability checks will pass with warnings.`,
    );
    _capTable = {};
    return _capTable;
  }
  try {
    _capTable = JSON.parse(fs.readFileSync(CAPABILITIES_PATH, 'utf8')) as CapabilityTable;
    return _capTable;
  } catch (e) {
    console.warn(`provider-capabilities: WARNING failed to load capability table: ${String(e)}`);
    _capTable = {};
    return _capTable;
  }
}

/**
 * Normalize model string to a lookup key.
 * LiteLLM uses "provider/model" format e.g. "anthropic/claude-opus-4-5".
 * We try exact match, then strip provider prefix.
 */
function lookupModel(table: CapabilityTable, model: string): ModelCapabilityEntry | null {
  // Exact match first
  if (table[model]) return table[model]!;

  // Try with provider prefix stripped
  const slashIdx = model.indexOf('/');
  if (slashIdx !== -1) {
    const modelName = model.slice(slashIdx + 1);
    if (table[modelName]) return table[modelName]!;
  }

  // Fuzzy: find any key that contains the model name
  const lowerModel = model.toLowerCase();
  for (const [key, entry] of Object.entries(table)) {
    if (key.toLowerCase().includes(lowerModel) || lowerModel.includes(key.toLowerCase())) {
      return entry;
    }
  }

  return null;
}

/**
 * Check whether a provider model satisfies an extension's requires block.
 *
 * @param model — LiteLLM model string, e.g. "anthropic/claude-opus-4-5" or "ollama/llama3"
 * @param requires — The extension.json requires block
 * @returns { ok: true, warnings: [] } if all requirements are met;
 *          { ok: false, warnings: [...] } if any requirement is unmet.
 */
export function checkProviderCapabilities(
  model: string,
  requires: RequiresBlock,
): CapabilityResult {
  const warnings: string[] = [];
  const table = loadCapabilityTable();
  const entry = lookupModel(table, model);

  if (!entry) {
    // Unknown model — emit a warning but don't fail (conservative: assume capable)
    warnings.push(
      `Unknown model "${model}" — capability check skipped. ` +
        `Update assets/model_capabilities.json to include this model.`,
    );
    return { ok: true, warnings };
  }

  // Check tool_calling
  if (requires.tool_calling === true) {
    const hasToolCalling =
      entry.supports_function_calling === true ||
      entry.supports_tool_choice === true ||
      entry.tool_calling === true ||
      entry.function_calling === true;
    if (!hasToolCalling) {
      warnings.push(
        `requires.tool_calling=true but model "${model}" does not support tool/function calling. ` +
          `Switch to a tool-capable model (e.g. anthropic/claude-opus-4-5, openai/gpt-4o).`,
      );
    }
  }

  // Check structured_output
  if (requires.structured_output === true) {
    const hasStructuredOutput =
      entry.supports_response_schema === true || entry.structured_output === true;
    if (!hasStructuredOutput) {
      warnings.push(
        `requires.structured_output=true but model "${model}" does not support structured output. ` +
          `Switch to a model with structured output support.`,
      );
    }
  }

  // Check min_context_tokens
  if (requires.min_context_tokens !== undefined) {
    const contextWindow = entry.max_input_tokens ?? entry.max_tokens;
    if (contextWindow !== undefined && contextWindow < requires.min_context_tokens) {
      warnings.push(
        `requires.min_context_tokens=${requires.min_context_tokens} but model "${model}" ` +
          `only supports ${contextWindow} input tokens.`,
      );
    }
  }

  return {
    ok: warnings.length === 0,
    warnings,
  };
}

// Re-export for use in install.ts and tests
export { loadCapabilityTable };
