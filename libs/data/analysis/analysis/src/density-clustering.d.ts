declare module 'density-clustering' {
  class DBSCAN {
    dataset: unknown[];
    epsilon: number;
    minPts: number;
    distance: (p: unknown, q: unknown) => number;
    clusters: number[][];
    noise: number[];

    constructor(
      dataset?: number[][],
      epsilon?: number,
      minPts?: number,
      distanceFunction?: (a: number[], b: number[]) => number,
    );

    run(
      dataset: number[][],
      epsilon: number,
      minPts: number,
      distanceFunction: (a: number[], b: number[]) => number,
    ): number[][];

    _init(
      dataset: number[][],
      epsilon: number,
      minPts: number,
      distanceFunction: (a: number[], b: number[]) => number,
    ): void;
  }

  const _default: {
    DBSCAN: typeof DBSCAN;
    default?: typeof DBSCAN;
  };
  export default _default;
}
