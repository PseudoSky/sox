1: import os from 'node:os';
2: 
3: /**
4:  * Shared vitest thread-pool cap (DEBT-TEST-CPU-OVERSUBSCRIBED-001).
5:  *
6:  * Vitest's default pool (`'threads'`) sizes itself to `os.cpus().length`
7:  * worker threads PER PROJECT it runs `test` for. Nx runs several projects'
8:  * `test` targets concurrently (`nx.json` `parallel`), so N concurrently
9:  * running projects each spinning up to `os.cpus().length` threads
10:  * oversubscribes the machine by up to Nx over — measured directly on this
11:  * repo: `nx test backlog` alone already averages ~207% CPU (234.74s user +
12:  * 52.24s sys over 138.35s wall, via `/usr/bin/time -l`), and that project
13:  * already pins itself to a single fork (`pool: 'forks'`, `fileParallelism:
14:  * false`); projects left on vitest's unbounded default are the ones that
15:  * can multiply this across a concurrent `nx affected -t test` run.
16:  *
17:  * Capping each project's own pool keeps the aggregate bounded to a sane
18:  * multiple of core count regardless of how many projects Nx runs at once,
19:  * without touching `nx.json`'s `parallel` setting (owned elsewhere).
20:  */
21: const cores = os.cpus().length;
22: 
23: /** Per-project worker-thread ceiling. Floor of 2 so small-core CI boxes still
24:  * get real parallelism within one project; capped at 4 so a handful of
25:  * concurrently-run projects can't collectively exceed a typical dev/CI
26:  * machine's core count by more than ~2-3x. */
27: export const maxTestThreads = Math.max(2, Math.min(4, Math.ceil(cores / 3)));
28: 
29: /** Spread into a vitest `test` config's `poolOptions` (for projects using the
30:  * default `'threads'` pool). Projects that opt into `pool: 'forks'` set

(Showing lines 1-30 of 34. Use offset=31 to continue.)