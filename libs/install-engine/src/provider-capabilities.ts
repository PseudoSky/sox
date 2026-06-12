/**
 * libs/install-engine/src/provider-capabilities.ts — Static capability matrix query
 *
 * Ported from scripts/provider-capabilities.ts. Zero logic changes.
 * [inv:fix-carry-forward]: no session fixes in this file; pure function.
 *
 * Contract (Section 2, Gap 5):
 *   Given a model string and an extension's requires block,
 *   look up the model in the vendored capability table and return
 *   { ok: boolean, warnings: string[] }
 *
 *   Side effects: none — pure (reads assets/model_capabilities.json at load time).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// __dirname is available in CJS (tsconfig module=CommonJS)
declare const __dirname: string;
// assets/ lives at the repo root, three levels up from libs/install-engine/dist/
const ASSETS_DIR = path.resolve(__dirname, '..', '..', '..', 'assets');
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
  tool_calling?: boolean;
  function_calling?: boolean;
  structured_output?: boolean;
}

type CapabilityTable = Record<string, ModelCapabilityEntry>;

let _capTable: CapabilityTable | null = null;

export function loadCapabilityTable(): CapabilityTable {
  if (_capTable) return _capTable;
  if (!fs.existsSync(CAPABILITIES_PATH)) {
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

function lookupModel(table: CapabilityTable, model: string): ModelCapabilityEntry | null {
  if (table[model]) return table[model]!;

  const slashIdx = model.indexOf('/');
  if (slashIdx !== -1) {
    const modelName = model.slice(slashIdx + 1);
    if (table[modelName]) return table[modelName]!;
  }

  const lowerModel = model.toLowerCase();
  for (const [key, entry] of Object.entries(table)) {
    if (key.toLowerCase().includes(lowerModel) || lowerModel.includes(key.toLowerCase())) {
      return entry;
    }
  }

  return null;
}

export function checkProviderCapabilities(
  model: string,
  requires: RequiresBlock,
): CapabilityResult {
  const warnings: string[] = [];
  const table = loadCapabilityTable();
  const entry = lookupModel(table, model);

  if (!entry) {
    warnings.push(
      `Unknown model "${model}" — capability check skipped. ` +
        `Update assets/model_capabilities.json to include this model.`,
    );
    return { ok: true, warnings };
  }

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
