# Changelog

## 0.1.0

- Initial release of the `finance` skill: a router over non-overlapping playbooks (P0 portfolio review, P1 single-name research, P2 regime posture, P3 screening, P5 trade plan, P6 position size, P7 validation, P12 portfolio report; P4, P8, P9, P10, P11 and E specified or stubbed).
- Broker-neutral portfolio record (v0) with a brokerage inlet: the agent authors a per-file mapping, and the deterministic core validates it and writes atomically (reject writes nothing).
- Paper accounts (`.finance/accounts/<id>/`): snapshots, a `current` pointer, an append-only ledger, configurable commission, slippage, fill rules and option mode. Shared broker interface: place, fill, cancel, positions, reconcile. No live broker is connected.
- Trade plan v0 schema shared across playbooks; `live:` mode requires an approval record naming the account, and nothing is executed in this version.
- Harvested skill sources kept verbatim under `sources/` with `SKILL.source.md` (not scanned as skills).
