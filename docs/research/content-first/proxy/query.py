#!/usr/bin/env python3
"""query.py — structured queries over the cf/fj proxy session logs.

Strictly reads the per-session JSONL logs (proxy-ses_<id>.jsonl and their
fork sub-sessions proxy-ses_<id>_fj-<uuid>.jsonl). Every field below is read
from a log event — no inference, no re-derivation.

Commands:
  sessions                  list session ids, newest first
  sessions --last           the newest session id + all its fork sub-session ids
  turns <session-id>...     per-turn rows for the given session(s)
  turns --sessions <a> <b>  per-turn rows over a SET of session ids, chronological
  turns --json <id>         same rows as JSON (programmatic use)

Per-turn row fields (one row per provider request):
  session_id         the session (or fork sub-session) the turn belongs to
  agent              the persona that ran the turn (fork agent / main agent)
  persona_index      fork index within the fork round (-1 for main turns)
  message_count      total messages in the forwarded provider payload
  has_cf_instructions  position-0 carries the CF-instructions block
  has_fj_instructions  any message carries the FJ handoff trigger text
  cached_tokens      prompt_cache_hit_tokens (read at the hit rate)
  uncached_tokens    prompt_tokens - cached (read at the miss rate)

Exit codes: 0 ok, 1 no logs found / bad session id, 2 bad usage.
"""

import argparse
import glob
import json
import os
import re
import subprocess
import sys

LOG_GLOB = 'proxy-ses_*.jsonl'


def load_markers():
    """Read the instruction/marker TEXTS from cf-rewrite.mjs — the source of
    truth — instead of duplicating them here (the FJ trigger text drifted
    once and silently broke detection). Falls back to last-known values with
    a warning if node is unavailable or the module changes shape."""
    fallback = {
        'fj_triggers': ('To hand off the current task', 'Fork-Join Session Instructions'),
        'cf_markers': ('--- CF-Instructions:v4 ---', '--- Content-First Session Instructions ---'),
        'cf_agent_re': r'--- CF-AGENT:([^:]*):sha256:',
    }
    try:
        script = (
            "import { MARKERS, buildCFInstructions, buildFJInstructions } from './cf-rewrite.mjs'; "
            "console.log(JSON.stringify({"
            "instructions: MARKERS.instructions, "
            "agentStart: MARKERS.agentStart('x', 'y'), "
            "cfText: buildCFInstructions(3333), "
            "fjText: buildFJInstructions(3333)"
            "}))"
        )
        out = subprocess.run(
            ['node', '--input-type=module', '-e', script],
            cwd=log_dir(), capture_output=True, text=True, timeout=15,
        )
        if out.returncode != 0:
            raise ValueError(out.stderr[:200])
        data = json.loads(out.stdout)
        fj_first = next((ln.strip() for ln in (data.get('fjText') or '').splitlines() if ln.strip()), '')
        cf_inner = '--- Content-First Session Instructions ---'
        if not fj_first or cf_inner not in (data.get('cfText') or ''):
            raise ValueError('marker text mismatch')
        agent_start = data.get('agentStart') or ''
        # derive the regex from the template (name → capture group)
        cf_agent_re = re.escape('--- CF-AGENT:') + r'([^:]*):sha256:'
        if not re.match(cf_agent_re, agent_start):
            raise ValueError('agentStart template mismatch')
        return {
            'fj_triggers': (fj_first,),
            'cf_markers': (data['instructions'], cf_inner),
            'cf_agent_re': cf_agent_re,
        }
    except Exception as e:
        print(f'[query.py] WARNING: could not read markers from cf-rewrite.mjs ({e}); using last-known values', file=sys.stderr)
        return fallback


def log_dir():
    """Directory containing the session logs (this script's directory)."""
    return os.path.dirname(os.path.abspath(__file__))


MARKERS_CFG = load_markers()
FJ_TRIGGER_MARKERS = MARKERS_CFG['fj_triggers']
CF_MARKERS = MARKERS_CFG['cf_markers']
CF_AGENT_RE = re.compile(MARKERS_CFG['cf_agent_re'])


def log_dir():
    """Directory containing the session logs (this script's directory)."""
    return os.path.dirname(os.path.abspath(__file__))


def list_session_files():
    """(main_session_file, sub_session_files) pairs, newest main first."""
    files = sorted(glob.glob(os.path.join(log_dir(), LOG_GLOB)))
    mains = [f for f in files if '_fj-' not in os.path.basename(f)]
    subs = [f for f in files if '_fj-' in os.path.basename(f)]
    # sort mains by mtime, newest first
    mains.sort(key=os.path.getmtime, reverse=True)
    return mains, subs


def session_id_from_file(path):
    return os.path.basename(path).replace('proxy-ses_', '').replace('.jsonl', '')


def read_events(path):
    events = []
    try:
        with open(path, 'r') as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    return events


def turns_for_session(session_id):
    """Per-turn rows for a session id (main or fork sub-session)."""
    main_files, _ = list_session_files()
    main_by_id = {session_id_from_file(f): f for f in main_files}
    if session_id in main_by_id:
        # a main session: also include its fork sub-sessions (chronological)
        sub_files = sorted(
            f for f in glob.glob(os.path.join(log_dir(), LOG_GLOB))
            if session_id + '_fj-' in os.path.basename(f)
        )
        return _turns_from(main_by_id[session_id]) + [
            row for sf in sub_files
            for row in _turns_from(sf)
        ]
    # a fork sub-session id, e.g. <main>#fj-<uuid> (sanitized to _)
    sub_path = os.path.join(log_dir(), f'proxy-ses_{session_id}.jsonl')
    if os.path.exists(sub_path):
        main_id = session_id.split('_fj-')[0]
        main_file = main_by_id.get(main_id)
        return _turns_from(sub_path, main_file)
    return []


def persona_from_transcript(msgs):
    """(name, index) of the persona block actually sent. The persona is the
    APPENDED suffix, so scan the message array from the TAIL and report the
    message index where the last `--- CF-AGENT:<name>:sha256:` block sits —
    read from the data, never assumed to be message_count - 1 (a mid-
    conversation leaked marker would not be mistaken for it). `name` may be ''
    when the turn ran with no named persona."""
    if not msgs:
        return None, -1
    for i in range(len(msgs) - 1, -1, -1):
        mm = CF_AGENT_RE.search(str(msgs[i].get('content', '')))
        if mm:
            return mm.group(1), i
    return None, -1


def _turns_from(session_file):
    events = read_events(session_file)
    rows = []
    pending = None   # a forward_request awaiting its following raw_response usage
    for ev in events:
        if ev.get('event') == 'forward_request':
            msgs = ev.get('messages', [])
            # opencode's internal title-generation calls route through the
            # proxy too (system = "You are a title generator…") — they are
            # NOT conversation turns and would break the message-count
            # progression (3 → 2 decrease). Exclude them.
            pos0 = str(msgs[0].get('content', '')) if msgs else ''
            if 'You are a title generator' in pos0:
                pending = None
                continue
            has_cf = any(mk in pos0 for mk in CF_MARKERS)
            has_fj = any(
                marker in str(m.get('content', ''))
                for m in msgs for marker in FJ_TRIGGER_MARKERS
            )
            agent, p_idx = persona_from_transcript(msgs)
            pending = {
                'session_id': session_id_from_file(session_file),
                'agent': agent,
                'persona_index': p_idx,
                'message_count': len(msgs),
                'has_cf_instructions': has_cf,
                'has_fj_instructions': has_fj,
                'cached_tokens': 0,
                'uncached_tokens': 0,
            }
        elif ev.get('event') == 'raw_response' and ev.get('usage') and pending is not None:
            u = ev['usage']
            cached = u.get('cache_hit', 0) or 0
            prompt = u.get('prompt', 0) or 0
            pending['cached_tokens'] = cached
            pending['uncached_tokens'] = max(0, prompt - cached)
            rows.append(pending)
            pending = None
    if pending is not None:
        rows.append(pending)   # request whose response was never logged
    return rows


def print_rows(rows, as_json=False):
    if as_json:
        print(json.dumps(rows, indent=2))
        return
    if not rows:
        print('(no turns found)')
        return
    header = ('session_id', 'agent', 'persona_index', 'message_count',
              'has_cf_instructions', 'has_fj_instructions', 'cached_tokens', 'uncached_tokens')
    widths = {k: max(len(str(r.get(k, ''))) for r in rows + [dict.fromkeys(header, k)]) for k in header}
    fmt = '  '.join(f'{{{k}:<{w}}}' for k, w in widths.items())
    print(fmt.format(**{k: k for k in header}))
    for r in rows:
        print(fmt.format(**{k: str(r.get(k, '')) for k in header}))


def main():
    ap = argparse.ArgumentParser(description='Query cf/fj proxy session logs.')
    ap.add_argument('cmd', choices=['sessions', 'turns'])
    ap.add_argument('ids', nargs='*', help='session id(s)')
    ap.add_argument('--last', action='store_true', help='sessions: newest session + fork sub-session ids')
    ap.add_argument('--sessions', nargs='+', metavar='ID', help='turns: a SET of session ids, chronological')
    ap.add_argument('--json', action='store_true', help='JSON output')
    args = ap.parse_args()

    mains, subs = list_session_files()
    if not mains:
        print('no session logs found in', log_dir(), file=sys.stderr)
        sys.exit(1)

    if args.cmd == 'sessions':
        if args.last:
            newest = session_id_from_file(mains[0])
            print(newest)
            for sf in sorted(subs):
                if newest + '_fj-' in os.path.basename(sf):
                    print(f'  {session_id_from_file(sf)}')
        else:
            for f in mains:
                print(session_id_from_file(f))
        return

    # turns
    ids = args.ids or args.sessions or []
    if not ids:
        ap.error('turns requires at least one session id (or --sessions)')
    rows = []
    for sid in ids:
        rows.extend(turns_for_session(sid))
    print_rows(rows, as_json=args.json)


if __name__ == '__main__':
    main()
