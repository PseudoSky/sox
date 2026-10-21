# P9 options-analysis

Analysis only. Reads: options chains, which no bound capability provides here, so P9 reports "unavailable" and stops; it never estimates a chain. For an observed 0DTE trade use P11, which needs no chain. Emits: an options receipt. Source skill: options-strategy-advisor. Options orders are not placed here; paper option fills need the account's `options: full_fills` setting.
A covered call needs shares of the underlying: state from `analyze` whether the account holds them (and how many round lots) before reporting that a chain is unavailable.
