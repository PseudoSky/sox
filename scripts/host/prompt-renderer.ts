/**
 * scripts/host/prompt-renderer.ts — Prompt template renderer.
 *
 * CONTRACT GAP CLOSED (analysis row #9 for prompt type):
 *   Renders a prompt manifest's template file with caller-supplied parameters.
 *   This is the delivery layer for the 'prompt' runtime type.
 *
 * Template engine: Handlebars-compatible mustache syntax.
 *   Supports: {{variable}}, {{#if condition}}...{{/if}}, {{{triple-brace-unescaped}}}.
 *
 * Design: no external Handlebars dependency — implements a minimal subset of the
 *   Handlebars syntax that covers the greeting-prompt use case and the declared
 *   template_engine: "handlebars" convention. This avoids adding a new dependency
 *   while satisfying the acceptance check. If richer template support is needed
 *   in future, swap in the handlebars package here.
 *
 * Prompt manifest convention:
 *   - extension.json declares type: "prompt", template_engine, and parameters[]
 *   - The template lives at <extDir>/prompt.md (co-located with extension.json)
 *   - Parameters are validated against the declared parameters[] spec
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PromptParameter {
  name: string;
  type: string;
  required?: boolean | undefined;
  description?: string | undefined;
  default?: unknown;
}

export interface PromptManifest {
  id: string;
  version: string;
  type: 'prompt';
  title?: string | undefined;
  description?: string | undefined;
  template_engine?: string | undefined;
  parameters?: PromptParameter[] | undefined;
  [key: string]: unknown;
}

export interface RenderOptions {
  /** Directory containing extension.json and prompt.md */
  extDir: string;
  /** Parameter values to substitute into the template */
  params: Record<string, unknown>;
  /** Optional: explicit template content (bypasses file read — for testing) */
  templateContent?: string | undefined;
}

export interface RenderResult {
  rendered: string;
  promptId: string;
  warnings: string[];
}

// ─── PromptRenderer ───────────────────────────────────────────────────────────

/**
 * PromptRenderer — renders a prompt template with caller-supplied parameters.
 *
 * Closes analysis row #9 for the 'prompt' type: installed prompt → rendered output.
 */
export class PromptRenderer {
  /**
   * Render a prompt from an extension directory.
   *
   * Reads extension.json to get the parameter spec, then reads prompt.md
   * (or the provided templateContent) and substitutes params.
   */
  render(opts: RenderOptions): RenderResult {
    const warnings: string[] = [];

    // Load manifest
    const manifestPath = path.join(opts.extDir, 'extension.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`[prompt-renderer] No extension.json found at ${manifestPath}`);
    }

    let manifest: PromptManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PromptManifest;
    } catch (e) {
      throw new Error(`[prompt-renderer] Failed to parse extension.json: ${String(e)}`);
    }

    if (manifest.type !== 'prompt') {
      throw new Error(
        `[prompt-renderer] Extension at ${opts.extDir} has type "${manifest.type}", expected "prompt"`,
      );
    }

    // Validate parameters against declared spec
    const paramSpec = manifest.parameters ?? [];
    for (const spec of paramSpec) {
      if (spec.required && !(spec.name in opts.params)) {
        throw new Error(
          `[prompt-renderer] Required parameter "${spec.name}" not supplied for prompt "${manifest.id}". ` +
            `Description: ${spec.description ?? '(none)'}`,
        );
      }
    }

    // Warn about unknown params
    const knownNames = new Set(paramSpec.map((p) => p.name));
    for (const key of Object.keys(opts.params)) {
      if (!knownNames.has(key)) {
        warnings.push(`Unknown parameter "${key}" supplied to prompt "${manifest.id}" — will be substituted but is not declared in parameters[]`);
      }
    }

    // Load template content
    let templateContent: string;
    if (opts.templateContent !== undefined) {
      templateContent = opts.templateContent;
    } else {
      const templatePath = path.join(opts.extDir, 'prompt.md');
      if (!fs.existsSync(templatePath)) {
        throw new Error(
          `[prompt-renderer] No prompt.md found at ${templatePath}. ` +
            `Prompt extensions must include a prompt.md template file.`,
        );
      }
      templateContent = fs.readFileSync(templatePath, 'utf8');
    }

    // Strip YAML front matter (---\n...\n---\n) if present
    const strippedTemplate = stripFrontMatter(templateContent);

    // Render using our Handlebars-compatible engine
    const rendered = renderHandlebars(strippedTemplate, opts.params);

    return {
      rendered,
      promptId: manifest.id,
      warnings,
    };
  }
}

// ─── Template engine (Handlebars-compatible subset) ───────────────────────────

/**
 * Strip YAML front matter from a template string.
 * Front matter is delimited by `---` on lines by themselves.
 */
function stripFrontMatter(content: string): string {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') {
    return content;
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return content; // No closing --- found — treat as not front matter
  }
  return lines.slice(endIdx + 1).join('\n').replace(/^\n/, '');
}

/**
 * Render a Handlebars-compatible template with the given context.
 *
 * Supported features:
 *   - {{variable}}     — HTML-escape substitution
 *   - {{{variable}}}   — Raw (unescaped) substitution
 *   - {{#if var}}...{{/if}}  — Conditional block (truthy check)
 *   - {{#if var}}...{{else}}...{{/if}}  — Conditional with else
 */
function renderHandlebars(template: string, ctx: Record<string, unknown>): string {
  // Process block helpers first (top-down, non-nested for simplicity)
  let result = processIfBlocks(template, ctx);

  // Then substitute variables (triple-brace raw first, then double-brace escaped)
  result = result.replace(/\{\{\{(\w[\w.]*)\}\}\}/g, (_, key: string) => {
    return String(resolveKey(ctx, key) ?? '');
  });

  result = result.replace(/\{\{(\w[\w.]*)\}\}/g, (_, key: string) => {
    const value = resolveKey(ctx, key);
    if (value === undefined || value === null) return '';
    return htmlEscape(String(value));
  });

  return result;
}

/**
 * Process {{#if var}}...{{else}}...{{/if}} blocks.
 * Handles one level of nesting (sufficient for the current prompt templates).
 */
function processIfBlocks(template: string, ctx: Record<string, unknown>): string {
  // Regex: {{#if VAR}} CONTENT {{/if}}  (with optional {{else}})
  const IF_BLOCK = /\{\{#if\s+(\w[\w.]*)\}\}([\s\S]*?)\{\{\/if\}\}/g;

  return template.replace(IF_BLOCK, (_, varName: string, inner: string) => {
    const value = resolveKey(ctx, varName);
    const isTruthy = Boolean(value);

    // Split on {{else}}
    const elseIdx = inner.indexOf('{{else}}');
    if (elseIdx !== -1) {
      const thenPart = inner.slice(0, elseIdx);
      const elsePart = inner.slice(elseIdx + '{{else}}'.length);
      return isTruthy ? thenPart : elsePart;
    }

    return isTruthy ? inner : '';
  });
}

/** Resolve a dot-notation key from the context. */
function resolveKey(ctx: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let current: unknown = ctx;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Minimal HTML escaping (Handlebars default for {{var}}). */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
