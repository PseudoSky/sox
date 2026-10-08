// Pure summarizer shared by run.mjs and the AC3 test (2f81569f T11.AC3): rates are always derived from rows.
const rate = (rows) => (rows.length ? rows.filter((x) => x.pass).length / rows.length : null);

export function summarize(results, cases) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const arm = (a) => {
    const rows = results.filter((x) => x.arm === a);
    const sub = (f) => rate(rows.filter((x) => f(byId.get(x.case))));
    const perCase = {};
    for (const c of cases) {
      const r = rows.filter((x) => x.case === c.id);
      perCase[c.id] = `${r.filter((x) => x.pass).length}/${r.length}`;
    }
    return {
      passRate: rate(rows),
      staticRate: sub((c) => c.mode === 'static'),
      blindRate: sub((c) => c.mode !== 'static'),
      tunedRate: sub((c) => !c.heldOut),
      heldOutRate: sub((c) => c.heldOut),
      perCase,
      emptyOutputs: rows.filter((x) => !String(x.output).trim()).length,
    };
  };
  const detect = (a) => {
    const rows = results.filter((x) => x.arm === a && x.detected !== null);
    return `${rows.filter((x) => x.detected).length}/${rows.length}`;
  };
  return { baseline: arm('baseline'), variant: arm('variant'), bugDetection: { baseline: detect('baseline'), variant: detect('variant') } };
}

// agent-manager 7.5: a rate in [0.5, 0.8) is the soft-failure halt band
export const inHaltBand = (r) => r !== null && r >= 0.5 && r < 0.8;
