#!/usr/bin/env python3
"""
compare-rf-cf.py — Find the RF and CF runs in the proxy session logs and
produce a full side-by-side comparison.

WHAT IT DOES
------------
1. Scans proxy-ses_*.jsonl for sessions containing `turn` events.
2. Classifies each session as RF (passthrough=true / model=rf) or CF
   (passthrough=false / cf_* fields or model=cf).
3. Groups sessions into "runs" by proximity (a run = one dispatcher + its
   stage sessions, or one CF session with handoffs).
4. Computes per-stage metrics (turns, tokens, cached, savings, handoff cost)
   and full-run totals for each arm.
5. Prints a comparison table.

FIELD SCHEMAS HANDLED
---------------------
RF (new uniform schema):
  {event:turn, agent, turns, passthrough:true, tokens, cached, output,
   savings_pct, model:"rf"}
CF (older schema, still in the CF session logs):
  {event:turn, agent, turns, passthrough:false, cf_tokens, cf_cached,
   cf_output, savings_pct, cached_seed, ...}
  plus event:session_agent_set / handoff_pending for stage switches.

USAGE
-----
  python3 compare-rf-cf.py [--log-dir DIR] [--runs N] [--json]
"""

import argparse, glob, json, os, sys
from datetime import datetime, timedelta

# ───────────────────────── helpers ─────────────────────────

def load_sessions(log_dir):
    """Return {session_id: {"turns": [...], "handoffs": [...]}}."""
    sessions = {}
    for path in sorted(glob.glob(os.path.join(log_dir, "proxy-ses_*.jsonl"))):
        sid = os.path.basename(path).replace("proxy-ses_", "").replace(".jsonl", "")
        s = {"turns": [], "handoffs": [], "file": path}
        try:
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if not line: continue
                    try: d = json.loads(line)
                    except: continue
                    if d.get("event") == "turn":
                        s["turns"].append(d)
                    elif d.get("event") in ("session_agent_set", "handoff_pending"):
                        s["handoffs"].append(d)
        except Exception as e:
            print(f"  (skip {path}: {e})", file=sys.stderr)
        if s["turns"] or s["handoffs"]:
            sessions[sid] = s
    return sessions

def classify(session):
    """Return 'rf', 'cf', or 'mixed' based on the session's turns."""
    models = set()
    for t in session["turns"]:
        if t.get("passthrough") is True:
            models.add("rf")
        elif t.get("passthrough") is False:
            models.add("cf")
        elif t.get("model") in ("rf", "cf"):
            models.add(t.get("model"))
        else:
            # fall back to field presence
            if "cf_tokens" in t: models.add("cf")
            elif "tokens" in t: models.add("rf")
    if len(models) == 1: return models.pop()
    if not models: return "unknown"
    return "mixed"

def stage_sequence(session):
    """Ordered list of (agent, first_turn_index) — the chain within a session."""
    seq = []
    seen = set()
    for i, t in enumerate(session["turns"]):
        a = t.get("agent") or "(unassigned)"
        if a not in seen:
            seen.add(a)
            seq.append((a, i))
    return seq

def turn_tokens(t):
    """Return (input, cached, output, savings_pct) regardless of schema."""
    inp = t.get("tokens", t.get("cf_tokens", 0))
    cached = t.get("cached", t.get("cf_cached", 0))
    out = t.get("output", t.get("cf_output", 0))
    sav = t.get("savings_pct", "0")
    try: sav = float(sav)
    except: sav = 0.0
    return inp or 0, cached or 0, out or 0, sav

def stage_stats(turns):
    """Aggregate metrics over a list of turns."""
    n = len(turns)
    if n == 0: return None
    inp = sum(turn_tokens(t)[0] for t in turns)
    cached = sum(turn_tokens(t)[1] for t in turns)
    out = sum(turn_tokens(t)[2] for t in turns)
    avg_sav = sum(turn_tokens(t)[3] for t in turns) / n
    cold = [t for t in turns if turn_tokens(t)[1] == 0]
    return {
        "turns": n, "input": inp, "cached": cached, "output": out,
        "avg_savings": avg_sav, "cold_turns": len(cold),
    }

def group_runs(sessions, gap_minutes=90):
    """
    Group sessions into runs by start-time proximity AND arm. A run is a
    cluster of sessions of the SAME arm (rf or cf) whose first-turn
    timestamps fall within gap_minutes of the cluster start. This keeps an
    interleaved RF+CF sequence (e.g. RF stages running while a CF session is
    open) in separate runs.
    """
    # Only sessions that actually have turns participate
    dated = []
    for sid, s in sessions.items():
        arm = classify(s)
        if arm not in ("rf", "cf"): continue
        ts = None
        for t in s["turns"]:
            ts = t.get("_ts")
            if ts: break
        if not ts: continue
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except:
            continue
        dated.append((dt, sid, s, arm))
    dated.sort(key=lambda x: (x[3], x[0]))  # group by arm, then time

    runs = []
    current = []
    current_start = None
    current_arm = None
    for dt, sid, s, arm in dated:
        same_arm = arm == current_arm
        in_window = current_start is None or (dt - current_start) <= timedelta(minutes=gap_minutes)
        if same_arm and (not current or in_window):
            if not current: current_start = dt
            current_arm = arm
            current.append((sid, s))
        else:
            if current: runs.append(current)
            current = [(sid, s)]
            current_start = dt
            current_arm = arm
    if current: runs.append(current)
    return runs

def run_arm(run):
    """Classify a run by the majority arm of its sessions."""
    from collections import Counter
    arms = Counter(classify(s) for _, s in run)
    return arms.most_common(1)[0][0] if arms else "unknown"

def run_summary(run, gap_minutes=90):
    """Produce the comparison object for one run."""
    sessions_by_arm = {}
    for sid, s in run:
        arm = classify(s)
        sessions_by_arm.setdefault(arm, []).append((sid, s))

    def arm_total(sessions):
        all_turns = [t for _, s in sessions for t in s["turns"]]
        return stage_stats(all_turns)

    out = {
        "start": run[0][0] if run else None,
        "sessions": {sid: classify(s) for sid, s in run},
        "arms": {},
    }
    for arm, sess in sessions_by_arm.items():
        stats = arm_total(sess)
        if stats:
            out["arms"][arm] = {
                **stats,
                "stages": [],
                "handoffs": sum(len(s["handoffs"]) for _, s in sess),
            }
            # per-stage breakdown
            for sid, s in sess:
                seq = stage_sequence(s)
                for agent, first_idx in seq:
                    # stage = turns from first_idx until agent changes
                    stage_turns = []
                    for i in range(first_idx, len(s["turns"])):
                        if s["turns"][i].get("agent") != agent and stage_turns:
                            break
                        stage_turns.append(s["turns"][i])
                    # skip non-work stages (title-gen, dispatcher, unassigned)
                    if agent in ("(unassigned)", "(passthrough)", "cf-chain-dispatcher", "title"):
                        continue
                    st = stage_stats(stage_turns)
                    if st and st["input"] > 0:
                        out["arms"][arm]["stages"].append({
                            "session": sid[:20], "agent": agent, **st,
                        })
    return out

# ───────────────────────── main ─────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Compare RF and CF runs from proxy session logs")
    ap.add_argument("--log-dir", default=os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument("--runs", type=int, default=0, help="limit to the N most recent runs (0 = all)")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of tables")
    args = ap.parse_args()

    sessions = load_sessions(args.log_dir)
    if not sessions:
        print("No sessions found in", args.log_dir); return 1

    runs = group_runs(sessions)
    if args.runs > 0:
        runs = runs[-args.runs:]

    results = [run_summary(r) for r in runs if run_arm(r) in ("rf", "cf")]

    if args.json:
        print(json.dumps(results, indent=2, default=str)); return 0

    # ── Table output ──
    print(f"Found {len(sessions)} sessions, {len(runs)} runs "
          f"({len(results)} with rf/cf turns).\n")

    for ri, r in enumerate(results):
        print(f"═══ RUN {ri+1}  start={r['start']} ═══")
        print(f"  sessions: {', '.join(f'{sid[:16]}({arm})' for sid, arm in r['sessions'].items())}\n")

        for arm in ("rf", "cf"):
            if arm not in r["arms"]: continue
            a = r["arms"][arm]
            print(f"  ── {arm.upper()} arm ──")
            print(f"     turns={a['turns']}  input={a['input']:,}  cached={a['cached']:,}  "
                  f"output={a['output']:,}  avg_savings={a['avg_savings']:.1f}%  "
                  f"handoffs={a['handoffs']}")
            if a["stages"]:
                print(f"     {'agent':<14}{'turns':>6}{'input':>12}{'cached':>12}{'sav%':>8}{'cold':>6}")
                for st in a["stages"]:
                    print(f"     {st['agent']:<14}{st['turns']:>6}{st['input']:>12,}"
                          f"{st['cached']:>12,}{st['avg_savings']:>7.1f}%{st['cold_turns']:>6}")
            print()

        # cross-arm comparison
        if "rf" in r["arms"] and "cf" in r["arms"]:
            rf, cf = r["arms"]["rf"], r["arms"]["cf"]
            print(f"  ══ COMPARISON (RF vs CF) ══")
            print(f"     input tokens:  RF {rf['input']:,}  vs  CF {cf['input']:,}  "
                  f"({'%.1f%%' % (100*(rf['input']-cf['input'])/rf['input']) if rf['input'] else '?'} diff)")
            print(f"     cached tokens: RF {rf['cached']:,}  vs  CF {cf['cached']:,}")
            print(f"     avg savings:   RF {rf['avg_savings']:.1f}%  vs  CF {cf['avg_savings']:.1f}%")
            print(f"     turns:         RF {rf['turns']}  vs  CF {cf['turns']}")
            print()
        print()

    return 0

if __name__ == "__main__":
    sys.exit(main())
