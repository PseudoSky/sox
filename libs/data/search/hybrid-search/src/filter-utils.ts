import type { NodeFilter } from '@adhd/sox-graph-store';

interface FilterClause {
  sql: string;
  params: unknown[];
}

interface NodeFilterResult {
  nodeFilter: NodeFilter;
  extraClauses: FilterClause;
}

export function buildFilterClause(filters: Record<string, unknown>): NodeFilterResult {
  const nodeFilter: NodeFilter = {};
  const extraClauses: string[] = [];
  const extraParams: unknown[] = [];

  for (const [key, value] of Object.entries(filters)) {
    switch (key) {
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
        extraClauses.push('project_path = ?');
        extraParams.push(String(value));
        break;
      }
      case 'agent_id': {
        extraClauses.push('agent_id = ?');
        extraParams.push(String(value));
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
        extraClauses.push(`${key} = ?`);
        extraParams.push(value);
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
  };
}
