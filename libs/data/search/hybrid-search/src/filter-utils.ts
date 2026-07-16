import type { NodeFilter } from '@adhd/sox-graph-store';

interface FilterClause {
  sql: string;
  params: unknown[];
}

interface NodeFilterResult {
  nodeFilter: NodeFilter;
  extraClauses: FilterClause;
  /**
   * Filter keys that could not be mapped onto NodeFilter (graph-store's read/search
   * surface) — these are silently unenforceable by SqliteSearchBackend today
   * (BL-294). Non-empty means the caller's stated filters do not fully constrain
   * either the text or vector channel of the search; SqliteSearchBackend surfaces
   * this as `degraded.unsupportedFilters` on every result of the affected query.
   */
  unsupportedFilters: string[];
}

export function buildFilterClause(filters: Record<string, unknown>): NodeFilterResult {
  const nodeFilter: NodeFilter = {};
  const extraClauses: string[] = [];
  const extraParams: unknown[] = [];
  const unsupportedFilters: string[] = [];

  for (const [key, value] of Object.entries(filters)) {
    switch (key) {
      case 'kind': {
        if (typeof value === 'string') {
          nodeFilter.kind = value;
        } else if (Array.isArray(value)) {
          nodeFilter.kind = value.map((v) => String(v));
        }
        break;
      }
      case 'topic': {
        if (typeof value === 'string') {
          nodeFilter.topic = value;
        } else if (Array.isArray(value)) {
          nodeFilter.topic = value.map((v) => String(v));
        }
        break;
      }
      case 'tags': {
        if (Array.isArray(value)) {
          nodeFilter.tags = value.map((v) => String(v));
        }
        break;
      }
      case 'importance_min': {
        nodeFilter.importanceMin = Number(value);
        break;
      }
      case 'project_path': {
        nodeFilter.projectPath = String(value);
        break;
      }
      case 'agent_id': {
        nodeFilter.agentId = String(value);
        break;
      }
      case 'namespace': {
        nodeFilter.namespace = String(value);
        break;
      }
      case 'ids': {
        if (Array.isArray(value)) {
          nodeFilter.ids = value.map((v) => Number(v));
        }
        break;
      }
      case 'confidence': {
        nodeFilter.confidence = String(value) as
          | 'confirmed'
          | 'unverified'
          | 'disputed'
          | 'deprecated';
        break;
      }
      default: {
        // Unrecognized filter key — kept in extraClauses (raw SQL, back-compat) but
        // SqliteSearchBackend never applies extraClauses to either search channel, so
        // this is also recorded as unsupported (BL-294) and surfaced as a degrade signal.
        extraClauses.push(`${key} = ?`);
        extraParams.push(value);
        unsupportedFilters.push(key);
      }
    }
  }

  return {
    nodeFilter,
    extraClauses: {
      sql: extraClauses.length > 0
        ? `AND ${extraClauses.join(' AND ')}`
        : '',
      params: extraParams,
    },
    unsupportedFilters,
  };
}
