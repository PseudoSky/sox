import type { VectorBackend } from '@adhd/sox-vector-store';
import type { GraphBackend, NodeFilter, EdgeRel, NodeRecord } from '@adhd/sox-graph-store';
import densityClustering from 'density-clustering';
const DBSCANClass = (densityClustering as any).DBSCAN || (densityClustering as any).default?.DBSCAN || densityClustering;

export type { VectorBackend, VectorSpace, VecFilter } from '@adhd/sox-vector-store';
export type { GraphBackend, NodeRecord, NodeFilter, EdgeRel } from '@adhd/sox-graph-store';

// ── DB-integrated opts / result types ────────────────────────────────────────

export interface ClusterOpts {
  modelId?: string;
  minClusterSize?: number;
  threshold?: number;
}

export interface ClusterResult {
  communities: Array<{
    id: number;
    memberIds: number[];
    label?: string;
  }>;
  unclustered: number[];
  durationMs: number;
}

export interface SubsetClusterResult extends ClusterResult {
  filter: NodeFilter;
  totalInSubset: number;
}

export interface NearDupOpts {
  nearDupThreshold?: number;
  distinctThreshold?: number;
  modelId?: string;
  limit?: number;
}

export interface NearDupPair {
  a: number;
  b: number;
  cosine: number;
  status: 'near_dup' | 'candidate' | 'distinct';
}

export interface ImportanceOpts {
  filter?: NodeFilter;
  dryRun?: boolean;
}

export interface AutoLinkOpts {
  filter?: NodeFilter;
  similarityThreshold?: number;
  maxLinksPerNode?: number;
  rel?: EdgeRel;
  dryRun?: boolean;
}

export interface BatchOpts {
  filter?: NodeFilter;
  skip?: Array<'importance' | 'nearDup' | 'autoLinks' | 'clustering'>;
  dryRun?: boolean;
}

export interface BatchResult {
  nodesProcessed: number;
  nearDupPairsFound: number;
  autoLinksCreated: number;
  communitiesUpdated: number;
  durationMs: number;
}

// ── Pure types ───────────────────────────────────────────────────────────────

export interface TopoSortResult {
  order: number[];
  waves: Map<number, number>;
  cycle: number[] | null;
}

export type DAGStructure = 'forest' | 'series-parallel' | 'general';

export interface PackItem {
  id: number;
  cost: number;
  resources: string[];
  resourceCost: (key: string) => number;
  deps: number[];
  group?: string;
}

export interface PackOpts {
  B: number;
  W: number;
  algorithm?: 'auto' | 'bitmask-dp' | 'tree-dp' | 'simulated-annealing' | 'hlfet';
}

export interface PackResult {
  batches: Array<{ items: number[]; cost: number }>;
  totalCost: number;
  algorithm: string;
}

export interface OverlapEntry {
  a: number;
  b: number;
  intersection: string[];
  bytes: number;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function cosineDist(a: Float32Array, b: Float32Array): number {
  return 1 - cosineSim(a, b);
}

function toDbscanDataset(vecs: Float32Array[]): number[][] {
  return vecs.map((v) => Array.from(v));
}

function resolveModelId(vec: VectorBackend, opts?: { modelId?: string }): string {
  if (opts?.modelId) return opts.modelId;
  const spaces = vec.listSpaces();
  if (spaces.length === 0) throw new Error('No vector spaces available');
  return spaces[0]!.modelId;
}

// ── Pure algorithm exports ───────────────────────────────────────────────────

export function cluster(
  vecs: Array<{ id: number; vec: Float32Array }>,
  opts?: ClusterOpts,
): ClusterResult {
  const t0 = performance.now();
  const threshold = opts?.threshold ?? 0.75;
  const minClusterSize = opts?.minClusterSize ?? 2;

  if (vecs.length === 0) {
    return { communities: [], unclustered: [], durationMs: performance.now() - t0 };
  }

  const ids = vecs.map((v) => v.id);
  const fvecs = vecs.map((v) => v.vec);
  const epsilon = 1 - threshold;

  const dbscan = new DBSCANClass();
  const dataset = toDbscanDataset(fvecs);
  const clusters: number[][] = dbscan.run(dataset, epsilon, minClusterSize, cosineDist);
  const noise: number[] = dbscan.noise || [];

  const communities = clusters.map((memberIndices: number[], ci: number) => ({
    id: ci,
    memberIds: memberIndices.map((i: number) => ids[i]!),
  }));

  const unclustered = [
    ...noise.map((i: number) => ids[i]!),
    // Also include singletons suppressed by minClusterSize:
    // DBSCAN already handles this via minPts
  ];

  return {
    communities: communities.filter((c) => c.memberIds.length >= minClusterSize),
    unclustered: [...new Set(unclustered)],
    durationMs: performance.now() - t0,
  };
}

export function detectNearDupPairs(
  vecs: Array<{ id: number; vec: Float32Array }>,
  opts?: NearDupOpts,
): NearDupPair[] {
  const nearDupThreshold = opts?.nearDupThreshold ?? 0.95;
  const distinctThreshold = opts?.distinctThreshold ?? 0.70;
  const limit = opts?.limit;

  const pairs: NearDupPair[] = [];

  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      const cos = cosineSim(vecs[i]!.vec, vecs[j]!.vec);
      let status: NearDupPair['status'];
      if (cos >= nearDupThreshold) {
        status = 'near_dup';
      } else if (cos < distinctThreshold) {
        status = 'distinct';
      } else {
        status = 'candidate';
      }
      pairs.push({ a: vecs[i]!.id, b: vecs[j]!.id, cosine: cos, status });
    }
  }

  // Sort by cosine descending for deterministic output
  pairs.sort((a, b) => b.cosine - a.cosine || a.a - b.a || a.b - b.b);

  if (limit !== undefined) {
    return pairs.slice(0, limit);
  }
  return pairs;
}

export function scoreImportance(node: {
  inDegree: number;
  outDegree: number;
  recencyMs: number;
  nearDupCount: number;
}): number {
  const centralityScore = Math.min((node.inDegree + node.outDegree) / 10, 1.0) * 4.0;
  const recencyScore = Math.min(1.0 / (1 + node.recencyMs / 86400000), 1.0) * 3.0; // 1 day half-life
  const nearDupPenalty = Math.max(0, 1 - node.nearDupCount * 0.2) * 2.0;
  const base = 1.0;

  const raw = centralityScore + recencyScore + nearDupPenalty + base;
  return Math.max(1.0, Math.min(10.0, raw));
}

// ── Graph algorithm exports ──────────────────────────────────────────────────

export function topoSort(
  nodeIds: number[],
  getEdges: (id: number) => number[],
): TopoSortResult {
  const idSet = new Set(nodeIds);

  // inDegree = number of prerequisites (things I depend on)
  const inDegree = new Map<number, number>();
  // dependentsOf[d] = nodes that depend on d
  const dependentsOf = new Map<number, number[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    dependentsOf.set(id, []);
  }

  for (const id of nodeIds) {
    const deps = getEdges(id).filter((d) => idSet.has(d));
    inDegree.set(id, deps.length);
    for (const dep of deps) {
      if (!dependentsOf.has(dep)) dependentsOf.set(dep, []);
      dependentsOf.get(dep)!.push(id);
    }
  }

  const order: number[] = [];
  const waves = new Map<number, number>();

  // Start with nodes that have 0 prerequisites (wave 0)
  let queue: number[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      queue.push(id);
      waves.set(id, 0);
    }
  }

  let waveIndex = 0;
  while (queue.length > 0) {
    const nextQueue: number[] = [];
    for (const node of queue) {
      order.push(node);
    }
    waveIndex++;
    for (const node of queue) {
      for (const dependent of dependentsOf.get(node) ?? []) {
        const newDeg = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0 && !waves.has(dependent)) {
          nextQueue.push(dependent);
          waves.set(dependent, waveIndex);
        }
      }
    }
    queue = nextQueue;
  }

  if (order.length !== nodeIds.length) {
    const remaining = nodeIds.filter((id) => !order.includes(id));
    const cycle = findCycle(remaining, getEdges, idSet);
    return { order, waves, cycle };
  }

  return { order, waves, cycle: null };
}

function findCycle(
  remaining: number[],
  getEdges: (id: number) => number[],
  idSet: Set<number>,
): number[] | null {
  const visited = new Set<number>();
  const recStack: number[] = [];
  const recSet = new Set<number>();

  function dfs(node: number): number[] | null {
    visited.add(node);
    recStack.push(node);
    recSet.add(node);

    for (const dep of getEdges(node)) {
      if (!idSet.has(dep)) continue;
      if (!visited.has(dep)) {
        const result = dfs(dep);
        if (result) return result;
      } else if (recSet.has(dep)) {
        const cycleStart = recStack.indexOf(dep);
        return [...recStack.slice(cycleStart), dep];
      }
    }

    recStack.pop();
    recSet.delete(node);
    return null;
  }

  for (const id of remaining) {
    if (!visited.has(id)) {
      const cycle = dfs(id);
      if (cycle) return cycle;
    }
  }

  return null;
}

export function criticalPath(
  nodeIds: number[],
  getEdges: (id: number) => number[],
  getWeight: (id: number) => number,
): Map<number, number> {
  const idSet = new Set(nodeIds);
  const { order } = topoSort(nodeIds, getEdges);

  const pathLen = new Map<number, number>();

  // Process in topological order (nodes with 0 deps processed first)
  // For each node, path = weight + max(path of its deps)
  for (const id of order) {
    let maxDepPath = 0;
    for (const dep of getEdges(id).filter((d) => idSet.has(d))) {
      const depPath = pathLen.get(dep);
      if (depPath !== undefined && depPath > maxDepPath) {
        maxDepPath = depPath;
      }
    }
    pathLen.set(id, getWeight(id) + maxDepPath);
  }

  return pathLen;
}

export function detectCycles(
  nodeIds: number[],
  getEdges: (id: number) => number[],
): Array<number[]> {
  const idSet = new Set(nodeIds);
  const allCycles: Array<number[]> = [];
  const visited = new Set<number>();
  const recStack: number[] = [];
  const recSet = new Set<number>();

  function dfs(node: number): void {
    visited.add(node);
    recStack.push(node);
    recSet.add(node);

    for (const dep of getEdges(node)) {
      if (!idSet.has(dep)) continue;
      if (!visited.has(dep)) {
        dfs(dep);
      } else if (recSet.has(dep)) {
        const cycleStart = recStack.indexOf(dep);
        const cycle = [...recStack.slice(cycleStart), dep];
        allCycles.push(cycle);
      }
    }

    recStack.pop();
    recSet.delete(node);
  }

  for (const id of nodeIds) {
    if (!visited.has(id)) {
      dfs(id);
    }
  }

  return allCycles;
}

export function detectDAGStructure(
  nodeIds: number[],
  getEdges: (id: number) => number[],
): DAGStructure {
  const idSet = new Set(nodeIds);
  const parentCount = new Map<number, number>();

  for (const id of nodeIds) {
    parentCount.set(id, 0);
  }

  for (const id of nodeIds) {
    for (const dep of getEdges(id)) {
      if (idSet.has(dep)) {
        parentCount.set(dep, (parentCount.get(dep) ?? 0) + 1);
      }
    }
  }

  const maxParents = Math.max(...parentCount.values(), 0);
  if (maxParents <= 1) return 'forest';

  const cycles = detectCycles(nodeIds, getEdges);
  if (cycles.length > 0) return 'general';

  // Check series-parallel via Valdes-Tarjan-Lawler reduction
  if (isSeriesParallel(nodeIds, getEdges, idSet)) return 'series-parallel';

  return 'general';
}

function isSeriesParallel(
  nodeIds: number[],
  getEdges: (id: number) => number[],
  idSet: Set<number>,
): boolean {
  const adj = new Map<number, Set<number>>();
  for (const id of nodeIds) {
    adj.set(id, new Set(getEdges(id).filter((d) => idSet.has(d))));
  }

  // Build reverse adjacency
  const rev = new Map<number, Set<number>>();
  for (const id of nodeIds) rev.set(id, new Set());
  for (const [src, deps] of adj) {
    for (const d of deps) {
      rev.get(d)?.add(src);
    }
  }

  // Find source and sink
  let source = -1;
  let sink = -1;
  for (const id of nodeIds) {
    if ((rev.get(id)?.size ?? 0) === 0) source = id;
    if ((adj.get(id)?.size ?? 0) === 0) sink = id;
  }

  if (source === -1 || sink === -1) return false;

  // Apply reduction rules repeatedly
  const remaining = new Set(nodeIds);
  const activeAdj = new Map<number, Set<number>>();
  const activeRev = new Map<number, Set<number>>();

  for (const id of nodeIds) {
    activeAdj.set(id, new Set(adj.get(id) ?? []));
    activeRev.set(id, new Set(rev.get(id) ?? []));
  }

  let changed = true;
  while (changed && remaining.size > 2) {
    changed = false;

    // Series reduction: find a node with exactly 1 predecessor and 1 successor
    for (const v of remaining) {
      if ((activeRev.get(v)?.size ?? 0) === 1 && (activeAdj.get(v)?.size ?? 0) === 1) {
        const pred = [...activeRev.get(v)!][0]!;
        const succ = [...activeAdj.get(v)!][0]!;
        if (pred === succ) continue;

        activeAdj.get(pred)?.delete(v);
        activeRev.get(succ)?.delete(v);
        activeAdj.get(pred)?.add(succ);
        activeRev.get(succ)?.add(pred);
        activeAdj.delete(v);
        activeRev.delete(v);
        remaining.delete(v);
        changed = true;
        break;
      }
    }

    if (changed) continue;

    // Parallel reduction: find two nodes with same predecessors and successors
    const nodes = [...remaining];
    let foundParallel = false;
    for (let i = 0; i < nodes.length && !foundParallel; i++) {
      for (let j = i + 1; j < nodes.length && !foundParallel; j++) {
        const u = nodes[i]!;
        const v = nodes[j]!;
        const uPred = activeRev.get(u)!;
        const vPred = activeRev.get(v)!;
        const uSucc = activeAdj.get(u)!;
        const vSucc = activeAdj.get(v)!;

        if (setsEqual(uPred, vPred) && setsEqual(uSucc, vSucc)) {
          // Merge v into u
          for (const pred of vPred) activeAdj.get(pred)?.delete(v);
          for (const succ of vSucc) activeRev.get(succ)?.delete(v);
          activeAdj.delete(v);
          activeRev.delete(v);
          remaining.delete(v);
          changed = true;
          foundParallel = true;
        }
      }
    }
  }

  return true;
}

function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ── Batch scheduling ─────────────────────────────────────────────────────────

export function packBatches(items: PackItem[], opts: PackOpts): PackResult {
  const algo = opts.algorithm ?? 'auto';
  const selectedAlgo = algo === 'auto' ? selectAlgorithm(items, opts) : algo;

  switch (selectedAlgo) {
    case 'bitmask-dp':
      return packBitmaskDP(items, opts);
    case 'tree-dp':
      return packTreeDP(items, opts);
    case 'simulated-annealing':
      return packSimulatedAnnealing(items, opts);
    case 'hlfet':
    default:
      return packHLFET(items, opts);
  }
}

function selectAlgorithm(items: PackItem[], _opts: PackOpts): string {
  const N = items.length;
  if (N <= 20) return 'bitmask-dp';

  const idSet = new Set(items.map((i) => i.id));
  function getEdges(id: number): number[] {
    const item = items.find((i) => i.id === id);
    return (item?.deps ?? []).filter((d) => idSet.has(d));
  }
  const structure = detectDAGStructure(
    items.map((i) => i.id),
    getEdges,
  );

  if (N <= 50) {
    if (structure === 'forest' || structure === 'series-parallel') return 'tree-dp';
    return 'simulated-annealing';
  }
  return 'hlfet';
}

function batchCost(items: PackItem[], B: number): number {
  if (items.length === 0) return 0;
  const resourceCosts = new Map<string, number>();
  for (const item of items) {
    for (const r of item.resources) {
      resourceCosts.set(r, item.resourceCost(r));
    }
  }
  const totalResourceCost = [...resourceCosts.values()].reduce((s, c) => s + c, 0);
  const totalItemCost = items.reduce((s, i) => s + i.cost, 0);
  return B + totalResourceCost + totalItemCost;
}

function areDepsSatisfied(item: PackItem, earlierBatches: Set<number>, allItems: Map<number, PackItem>): boolean {
  return item.deps.every((depId) => {
    // dep must either be in an earlier batch or not in the item set
    return earlierBatches.has(depId) || !allItems.has(depId);
  });
}

function packBitmaskDP(items: PackItem[], opts: PackOpts): PackResult {
  const N = items.length;
  const totalSets = 1 << N;
  const dp = new Array<number>(totalSets).fill(Infinity);
  const prev = new Array<number>(totalSets).fill(-1);
  const batchForMask = new Array<number>(totalSets).fill(-1);
  dp[0] = 0;

  const itemMap = new Map(items.map((i) => [i.id, i]));

  // For very small N, enumerate all possibilities
  for (let mask = 0; mask < totalSets; mask++) {
    if (dp[mask] === Infinity) continue;

    // Available items: those with deps satisfied by current mask
    const maskSet = new Set<number>();
    for (let i = 0; i < N; i++) {
      if (mask & (1 << i)) maskSet.add(items[i]!.id);
    }

    // Find all subsets that can be batched together
    const available: number[] = [];
    for (let i = 0; i < N; i++) {
      if (!(mask & (1 << i))) {
        const item = items[i]!;
        // Check deps: all deps must be in already-processed mask
        const depsOk = item.deps.every((depId) => maskSet.has(depId) || !itemMap.has(depId));
        if (depsOk) {
          // Check group compatibility
          available.push(i);
        }
      }
    }

    // Try each non-empty subset of available
    const availSubsets = 1 << available.length;
    for (let s = 1; s < availSubsets; s++) {
      let batchMask = 0;
      const batchItems: PackItem[] = [];
      let valid = true;

      // Check group compatibility
      let group: string | undefined;
      for (let j = 0; j < available.length; j++) {
        if (s & (1 << j)) {
          const idx = available[j]!;
          const item = items[idx]!;
          if (group === undefined) {
            group = item.group;
          } else if (item.group !== group) {
            valid = false;
            break;
          }
          batchMask |= (1 << idx);
          batchItems.push(item);
        }
      }

      if (!valid) continue;

      const cost = batchCost(batchItems, opts.B);
      if (cost <= opts.W) {
        const newMask = mask | batchMask;
        const newCost = dp[mask]! + cost;
        if (newCost < dp[newMask]!) {
          dp[newMask] = newCost;
          prev[newMask] = mask;
          batchForMask[newMask] = batchMask;
        }
      }
    }
  }

  const fullMask = totalSets - 1;
  if (dp[fullMask] === Infinity) {
    // Fallback to HLFET
    return packHLFET(items, opts);
  }

  // Reconstruct batches
  const batches: Array<{ items: number[]; cost: number }> = [];
  let m = fullMask;
  while (m > 0 && batchForMask[m]! >= 0) {
    const bmask = batchForMask[m]!;
    const batchItems: number[] = [];
    const batchItemObjs: PackItem[] = [];
    for (let i = 0; i < N; i++) {
      if (bmask & (1 << i)) {
        batchItems.push(items[i]!.id);
        batchItemObjs.push(items[i]!);
      }
    }
    batches.unshift({
      items: batchItems,
      cost: batchCost(batchItemObjs, opts.B),
    });
    m = prev[m]!;
  }

  return {
    batches,
    totalCost: dp[fullMask]!,
    algorithm: 'bitmask-dp',
  };
}

function packHLFET(items: PackItem[], opts: PackOpts): PackResult {
  // Highest Level First with Estimated Time — greedy packing respecting deps
  const idSet = new Set(items.map((i) => i.id));
  const itemMap = new Map(items.map((i) => [i.id, i]));

  // Compute levels via topological sort
  const { waves } = topoSort(
    items.map((i) => i.id),
    (id) => (itemMap.get(id)?.deps ?? []).filter((d) => idSet.has(d)),
  );

  // Sort by level descending, then by cost descending
  const sorted = [...items].sort((a, b) => {
    const wA = waves.get(a.id) ?? 0;
    const wB = waves.get(b.id) ?? 0;
    if (wB !== wA) return wB - wA;
    return b.cost - a.cost;
  });

  const batches: Array<{ items: number[]; cost: number }> = [];
  const placed = new Set<number>();
  const processed = new Set<number>();

  while (placed.size < items.length) {
    const batchItems: PackItem[] = [];

    for (const item of sorted) {
      if (placed.has(item.id)) continue;
      // Check deps are in already-processed batches
      if (!areDepsSatisfied(item, processed, itemMap)) continue;
      // Check group compatibility
      const curGroup = batchItems[0]?.group;
      if (curGroup !== undefined && item.group !== curGroup) continue;
      // Check capacity
      const candidateItems = [...batchItems, item];
      if (batchCost(candidateItems, opts.B) > opts.W) continue;

      batchItems.push(item);
      placed.add(item.id);
    }

    if (batchItems.length === 0) {
      // Fallback: add remaining items one at a time
      for (const item of sorted) {
        if (!placed.has(item.id)) {
          batchItems.push(item);
          placed.add(item.id);
          break;
        }
      }
      if (batchItems.length === 0) break;
    }

    const cost = batchCost(batchItems, opts.B);
    batches.push({
      items: batchItems.map((i) => i.id),
      cost,
    });

    for (const item of batchItems) {
      processed.add(item.id);
    }
  }

  return {
    batches,
    totalCost: batches.reduce((s, b) => s + b.cost, 0),
    algorithm: 'hlfet',
  };
}

function packTreeDP(items: PackItem[], opts: PackOpts): PackResult {
  // For tree/series-parallel DAGs, use a simplified tree DP
  // This is a heuristic: group nodes with common deps
  const itemMap = new Map(items.map((i) => [i.id, i]));
  const idSet = new Set(items.map((i) => i.id));

  const { waves } = topoSort(
    items.map((i) => i.id),
    (id) => (itemMap.get(id)?.deps ?? []).filter((d) => idSet.has(d)),
  );

  // Group by wave, within wave by group
  const maxWave = Math.max(...waves.values(), 0);
  const batches: Array<{ items: number[]; cost: number }> = [];
  const processed = new Set<number>();

  for (let w = 0; w <= maxWave; w++) {
    const waveItems = items
      .filter((i) => waves.get(i.id) === w && !processed.has(i.id))
      .sort((a, b) => b.cost - a.cost);

    // Group by `group` field
    const byGroup = new Map<string | undefined, PackItem[]>();
    for (const item of waveItems) {
      const g = item.group;
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(item);
    }

    for (const [, groupItems] of byGroup) {
      let batchItems: PackItem[] = [];
      for (const item of groupItems) {
        if (processed.has(item.id)) continue;
        const candidateItems = [...batchItems, item];
        if (batchCost(candidateItems, opts.B) <= opts.W) {
          batchItems.push(item);
          processed.add(item.id);
        } else {
          // Flush batch
          if (batchItems.length > 0) {
            batches.push({
              items: batchItems.map((i) => i.id),
              cost: batchCost(batchItems, opts.B),
            });
          }
          batchItems = [item];
          processed.add(item.id);
        }
      }
      if (batchItems.length > 0) {
        batches.push({
          items: batchItems.map((i) => i.id),
          cost: batchCost(batchItems, opts.B),
        });
      }
    }
  }

  // Handle unprocessed items
  const unprocessed = items.filter((i) => !processed.has(i.id));
  for (const item of unprocessed) {
    batches.push({
      items: [item.id],
      cost: batchCost([item], opts.B),
    });
    processed.add(item.id);
  }

  return {
    batches,
    totalCost: batches.reduce((s, b) => s + b.cost, 0),
    algorithm: 'tree-dp',
  };
}

function packSimulatedAnnealing(items: PackItem[], opts: PackOpts): PackResult {
  // Start with HLFET solution, then improve via SA
  const initial = packHLFET(items, opts);

  if (initial.batches.length <= 1 || items.length <= 1) return initial;

  let currentBatches = initial.batches.map((b) => [...b.items]);
  let currentCost = initial.totalCost;
  let bestBatches = initial.batches.map((b) => [...b.items]);
  let bestCost = initial.totalCost;

  const itemMap = new Map(items.map((i) => [i.id, i]));
  const T0 = 100;
  const alpha = 0.95;
  const iterations = Math.max(200, items.length * 5);

  let T = T0;

  for (let iter = 0; iter < iterations; iter++) {
    // Pick a random item and try to move it to a different batch
    const fromBatchIdx = Math.floor(Math.random() * currentBatches.length);
    const fromBatch = currentBatches[fromBatchIdx]!;
    if (fromBatch.length === 0) continue;

    const itemIdx = Math.floor(Math.random() * fromBatch.length);
    const itemId = fromBatch[itemIdx]!;
    const item = itemMap.get(itemId)!;

    // Check if removing this item violates deps
    const remainingInFrom = fromBatch.filter((id) => id !== itemId);

    // Target: try an earlier batch (can always try this if deps permit)
    let targetIdx = fromBatchIdx;
    if (Math.random() < 0.5) {
      // Try moving earlier
      for (let bi = 0; bi < fromBatchIdx; bi++) {
        const targetBatch = currentBatches[bi]!;
        const candidateItems = targetBatch.map((id) => itemMap.get(id)!).filter(Boolean);
        // Check group compatibility
        const targetGroup = candidateItems[0]?.group;
        if (targetGroup !== undefined && item.group !== targetGroup) continue;
        candidateItems.push(item);
        if (batchCost(candidateItems, opts.B) <= opts.W) {
          targetIdx = bi;
          break;
        }
      }
    } else if (fromBatchIdx < currentBatches.length - 1) {
      // Try moving later
      const bi = fromBatchIdx + 1;
      const targetBatch = currentBatches[bi]!;
      const candidateItems = targetBatch.map((id) => itemMap.get(id)!).filter(Boolean);
      const targetGroup = candidateItems[0]?.group;
      if (targetGroup === undefined || item.group === targetGroup) {
        candidateItems.push(item);
        if (batchCost(candidateItems, opts.B) <= opts.W) {
          targetIdx = bi;
        }
      }
    }

    if (targetIdx === fromBatchIdx) continue;

    // Apply move
    const newBatches = currentBatches.map((b) => [...b]);
    newBatches[fromBatchIdx] = remainingInFrom;
    const newCost = computeTotalCost(newBatches, itemMap, opts);

    const delta = newCost - currentCost;
    if (delta < 0 || Math.random() < Math.exp(-delta / T)) {
      // Accept move
      newBatches[targetIdx] = [...newBatches[targetIdx]!, itemId];
      // Remove empty batches
      const cleaned = newBatches.filter((b) => b.length > 0);
      currentBatches = cleaned;
      currentCost = computeTotalCost(currentBatches, itemMap, opts);

      if (currentCost < bestCost) {
        bestBatches = currentBatches.map((b) => [...b]);
        bestCost = currentCost;
      }
    }

    T *= alpha;
  }

  return {
    batches: bestBatches.map((b) => ({
      items: b,
      cost: batchCost(
        b.map((id) => itemMap.get(id)!).filter(Boolean),
        opts.B,
      ),
    })),
    totalCost: bestCost,
    algorithm: 'simulated-annealing',
  };
}

function computeTotalCost(
  batches: number[][],
  itemMap: Map<number, PackItem>,
  opts: PackOpts,
): number {
  let total = 0;
  for (const batch of batches) {
    const items = batch.map((id) => itemMap.get(id)!).filter(Boolean);
    total += batchCost(items, opts.B);
  }
  return total;
}

export function setOverlapMatrix(
  items: Array<{ id: number; keys: string[] }>,
  valueFn?: (key: string) => number,
): OverlapEntry[] {
  const fn = valueFn ?? (() => 1);
  const entries: OverlapEntry[] = [];

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      const setA = new Set(a.keys);
      const intersection = b.keys.filter((k) => setA.has(k));
      const bytes = intersection.reduce((s, k) => s + fn(k), 0);

      entries.push({
        a: a.id,
        b: b.id,
        intersection,
        bytes,
      });
    }
  }

  return entries;
}

// ── DB-integrated functions ──────────────────────────────────────────────────

export async function clusterStore(
  vec: VectorBackend,
  graph: GraphBackend,
  opts?: ClusterOpts,
): Promise<ClusterResult> {
  const t0 = performance.now();
  const modelId = resolveModelId(vec, opts);

  const vecs: Array<{ id: number; vec: Float32Array }> = [];
  for (const item of vec.iter(modelId)) {
    vecs.push(item);
  }

  // Filter to only live nodes (those with vectors that are valid in the graph)
  const liveNodeIds = new Set(graph.queryNodes({}).map((n) => n.id));
  const liveVecs = vecs.filter((v) => liveNodeIds.has(v.id));

  const clusterOpts: ClusterOpts = {};
  if (opts?.threshold !== undefined) clusterOpts.threshold = opts.threshold;
  if (opts?.minClusterSize !== undefined) clusterOpts.minClusterSize = opts.minClusterSize;
  const result = cluster(liveVecs, clusterOpts);

  // Write communities back to graph
  const modelIdForMeta = modelId;
  for (const community of result.communities) {
    const memberIds = community.memberIds;

    // Find a label from the first member
    let label: string | undefined;
    const firstMember = memberIds[0];
    if (firstMember !== undefined) {
      const node = graph.getNode(firstMember);
      if (node) {
        label = node.topic ?? node.name ?? `cluster-${community.id}`;
      }
    }

    // Create community node
    const communityNodeId = graph.writeNode(`community-${community.id}`, {
      name: label ?? `community-${community.id}`,
      metadata: { modelId: modelIdForMeta, clusterId: community.id, memberCount: memberIds.length },
    });

    // Write MEMBER_OF edges
    for (const memberId of memberIds) {
      graph.writeEdge(memberId, communityNodeId, 'MEMBER_OF', {
        metadata: { modelId: modelIdForMeta },
      });
    }
  }

  return {
    communities: result.communities,
    unclustered: result.unclustered,
    durationMs: performance.now() - t0,
  };
}

export async function clusterSubset(
  vec: VectorBackend,
  graph: GraphBackend,
  filter: NodeFilter,
  opts?: ClusterOpts,
): Promise<SubsetClusterResult> {
  const t0 = performance.now();
  const modelId = resolveModelId(vec, opts);

  const vecs: Array<{ id: number; vec: Float32Array }> = [];
  for (const item of vec.iter(modelId)) {
    vecs.push(item);
  }

  const filteredNodes = graph.queryNodes(filter);
  const filteredIds = new Set(filteredNodes.map((n) => n.id));
  const subsetVecs = vecs.filter((v) => filteredIds.has(v.id));

  const clusterOpts2: ClusterOpts = {};
  if (opts?.threshold !== undefined) clusterOpts2.threshold = opts.threshold;
  if (opts?.minClusterSize !== undefined) clusterOpts2.minClusterSize = opts.minClusterSize;
  const result = cluster(subsetVecs, clusterOpts2);

  const modelIdForMeta = modelId;
  for (const community of result.communities) {
    const memberIds = community.memberIds;
    let label: string | undefined;
    const firstMember = memberIds[0];
    if (firstMember !== undefined) {
      const node = graph.getNode(firstMember);
      if (node) {
        label = node.topic ?? node.name ?? `cluster-${community.id}`;
      }
    }

    const communityNodeId = graph.writeNode(`subset-community-${community.id}`, {
      name: label ?? `subset-community-${community.id}`,
      metadata: { modelId: modelIdForMeta, clusterId: community.id, memberCount: memberIds.length, filter },
    });

    for (const memberId of memberIds) {
      graph.writeEdge(memberId, communityNodeId, 'MEMBER_OF', {
        metadata: { modelId: modelIdForMeta },
      });
    }
  }

  return {
    ...result,
    filter,
    totalInSubset: filteredNodes.length,
    durationMs: performance.now() - t0,
  };
}

export function detectNearDup(
  vec: VectorBackend,
  graph: GraphBackend,
  opts?: NearDupOpts,
): NearDupPair[] {
  const modelId = resolveModelId(vec, opts);
  const nearDupThreshold = opts?.nearDupThreshold ?? 0.95;

  const vecs: Array<{ id: number; vec: Float32Array }> = [];
  for (const item of vec.iter(modelId)) {
    vecs.push(item);
  }

  // Filter to live nodes
  const liveNodeIds = new Set(graph.queryNodes({}).map((n) => n.id));
  const liveVecs = vecs.filter((v) => liveNodeIds.has(v.id));

  const nearDupOptsObj: NearDupOpts = { nearDupThreshold };
  if (opts?.distinctThreshold !== undefined) nearDupOptsObj.distinctThreshold = opts.distinctThreshold;
  if (opts?.limit !== undefined) nearDupOptsObj.limit = opts.limit;
  const pairs = detectNearDupPairs(liveVecs, nearDupOptsObj);

  // Write SAME_AS edges for near_dup pairs
  for (const pair of pairs) {
    if (pair.status === 'near_dup') {
      graph.writeEdge(pair.a, pair.b, 'SAME_AS', {
        weight: pair.cosine,
        metadata: { cosine: pair.cosine, status: pair.status, modelId },
      });
    } else if (pair.status === 'candidate') {
      graph.writeEdge(pair.a, pair.b, 'SAME_AS', {
        weight: pair.cosine,
        metadata: { cosine: pair.cosine, status: 'candidate', modelId },
      });
    }
  }

  return pairs;
}

export function computeImportance(
  _vec: VectorBackend,
  graph: GraphBackend,
  opts?: ImportanceOpts,
): void {
  const filter = opts?.filter;

  // Get nodes to process (unscored or all, depending on filter)
  const nodes = graph.queryNodes(filter);
  const nodeMap = new Map<number, NodeRecord>();
  for (const n of nodes) {
    // Incremental: skip nodes that already have importance scored
    if (n.importance !== undefined && n.importance > 0 && !filter) continue;
    nodeMap.set(n.id, n);
  }

  if (nodeMap.size === 0) return;

  for (const [id, node] of nodeMap) {
    // Compute in/out degree
    const outEdges = graph.getEdges({ src: id });
    const inEdges = graph.getEdges({ dst: id });
    const inDegree = inEdges.length;
    const outDegree = outEdges.length;

    // Count nearDup edges
    const nearDupEdges = graph.getEdges({ rel: 'SAME_AS' });
    const nearDupCount = nearDupEdges.filter((e) => e.src === id || e.dst === id).length;

    // Recency: time since creation in ms
    const created = new Date(node.tCreated).getTime();
    const recencyMs = Date.now() - created;

    const importance = scoreImportance({ inDegree, outDegree, recencyMs, nearDupCount });

    if (!opts?.dryRun) {
      graph.touch(id, { importance });
    }
  }
}

export function buildAutoLinks(
  vec: VectorBackend,
  graph: GraphBackend,
  opts?: AutoLinkOpts,
): void {
  const similarityThreshold = opts?.similarityThreshold ?? 0.80;
  const maxLinksPerNode = opts?.maxLinksPerNode ?? 5;
  const rel = opts?.rel ?? 'RELATES_TO';

  const modelId = resolveModelId(vec);
  const filter = opts?.filter;

  const nodes = graph.queryNodes(filter);
  const nodeIds = new Set(nodes.map((n) => n.id));

  const vecs: Array<{ id: number; vec: Float32Array }> = [];
  for (const item of vec.iter(modelId)) {
    if (nodeIds.has(item.id)) {
      vecs.push(item);
    }
  }

  if (vecs.length < 2) return;

  // Compute pairwise similarities
  const candidates: Array<{ a: number; b: number; sim: number }> = [];
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      const sim = cosineSim(vecs[i]!.vec, vecs[j]!.vec);
      if (sim >= similarityThreshold) {
        candidates.push({ a: vecs[i]!.id, b: vecs[j]!.id, sim });
      }
    }
  }

  candidates.sort((a, b) => b.sim - a.sim);

  const linksPerNode = new Map<number, number>();
  for (const node of nodes) {
    linksPerNode.set(node.id, 0);
  }

  for (const c of candidates) {
    const linksA = linksPerNode.get(c.a) ?? 0;
    const linksB = linksPerNode.get(c.b) ?? 0;

    if (linksA < maxLinksPerNode && linksB < maxLinksPerNode) {
      if (!opts?.dryRun) {
        graph.writeEdge(c.a, c.b, rel, {
          weight: c.sim,
          metadata: { similarity: c.sim, modelId },
        });
      }
      linksPerNode.set(c.a, linksA + 1);
      linksPerNode.set(c.b, linksB + 1);
    }
  }
}

export async function runBatchEnrich(
  vec: VectorBackend,
  graph: GraphBackend,
  opts?: BatchOpts,
): Promise<BatchResult> {
  const t0 = performance.now();
  const skip = new Set(opts?.skip ?? []);

  const result: BatchResult = {
    nodesProcessed: 0,
    nearDupPairsFound: 0,
    autoLinksCreated: 0,
    communitiesUpdated: 0,
    durationMs: 0,
  };

  const nodes = graph.queryNodes(opts?.filter);
  result.nodesProcessed = nodes.length;

  // Step 1: Importance
  if (!skip.has('importance')) {
    const impOpts: ImportanceOpts = {};
    if (opts?.dryRun !== undefined) impOpts.dryRun = opts.dryRun;
    if (opts?.filter !== undefined) impOpts.filter = opts.filter;
    computeImportance(vec, graph, impOpts);
  }

  // Step 2: Near-dup detection
  if (!skip.has('nearDup')) {
    const pairs = detectNearDup(vec, graph);
    result.nearDupPairsFound = pairs.filter((p) => p.status === 'near_dup').length;
  }

  // Step 3: Auto-links
  if (!skip.has('autoLinks')) {
    if (opts?.dryRun) {
      // Count potential links for dryRun
      const simThreshold = 0.80;
      const modelId = resolveModelId(vec);
      const vecs: Array<{ id: number; vec: Float32Array }> = [];
      for (const item of vec.iter(modelId)) {
        vecs.push(item);
      }
      const nodeIds = new Set(nodes.map((n) => n.id));
      const liveVecs = vecs.filter((v) => nodeIds.has(v.id));
      let count = 0;
      for (let i = 0; i < liveVecs.length; i++) {
        for (let j = i + 1; j < liveVecs.length; j++) {
          if (cosineSim(liveVecs[i]!.vec, liveVecs[j]!.vec) >= simThreshold) {
            count++;
          }
        }
      }
      result.autoLinksCreated = count;
    } else {
      // Count existing edges to track created
      const beforeEdges = graph.getEdges({ rel: 'RELATES_TO' }).length;
      const alOpts: AutoLinkOpts = {};
      if (opts?.filter !== undefined) alOpts.filter = opts.filter;
      buildAutoLinks(vec, graph, alOpts);
      const afterEdges = graph.getEdges({ rel: 'RELATES_TO' }).length;
      result.autoLinksCreated = afterEdges - beforeEdges;
    }
  }

  // Step 4: Clustering
  if (!skip.has('clustering')) {
    const clusterResult = await clusterStore(vec, graph);
    result.communitiesUpdated = clusterResult.communities.length;
  }

  result.durationMs = performance.now() - t0;
  return result;
}
