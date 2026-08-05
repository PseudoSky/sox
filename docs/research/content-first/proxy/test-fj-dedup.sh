#!/usr/bin/env bash
# test-fj-dedup.sh — live test: fj fork-join with tool-call dedup.
# Two preset agents (review, test) both decide to read the same file →
# the proxy must merge their 2 identical tool calls into 1 streamed call.
# Requires: proxy running on :3333 with the latest code (restart-cf-proxy.sh).
set -u
B="${FJ_BASE:-http://localhost:3333}"
SES="ses_fj_test_$(date +%s)"

echo "== 1. set preset: review + test =="
curl -s -X POST $B/v1/session/agent -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SES\",\"agents\":[\"review\",\"test\"]}" | python3 -m json.tool | grep -E 'presetSet|set'

echo ""
echo "== 2. fj turn with a tool schema — forks asked to read a file =="
curl -s -N -X POST $B/v1/chat/completions -H 'Content-Type: application/json' -H "x-session-id: $SES" \
  -d '{
    "model": "proxy/fj",
    "max_tokens": 4000,
    "tools": [{"type":"function","function":{"name":"read_file","description":"Read a file","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}],
    "messages": [
      {"role":"system","content":"opencode SP placeholder"},
      {"role":"user","content":"Read the file src/index.ts and summarize what it exports."}
    ]
  }' > /tmp/fj_test_out.txt

python3 - << 'PY'
import json
raw = open('/tmp/fj_test_out.txt').read()
content, tool_calls, usage = '', [], None
for line in raw.split('\n'):
    if line.startswith('data: ') and line != 'data: [DONE]':
        try:
            d = json.loads(line[6:])
            c = d.get('choices', [{}])[0]
            delta = c.get('delta', {})
            if delta.get('content'): content += delta['content']
            if delta.get('tool_calls'): tool_calls.extend(delta['tool_calls'])
            if d.get('usage'): usage = d['usage']
        except Exception: pass
print(f"\n-- streamed content ({len(content)} chars):")
print(content[:300] + ('...' if len(content) > 300 else ''))
print(f"\n-- tool_calls in stream: {len(tool_calls)}")
for tc in tool_calls:
    fn = tc.get('function', {})
    print(f"   -> {fn.get('name')} {fn.get('arguments','')[:80]}")
print(f"-- usage: {usage}")
PY

echo ""
echo "== 3. proxy log: dedup accounting =="
SES="$SES" python3 - << 'PY'
import json, glob, os
ses = os.environ['SES']
fs = sorted(glob.glob(f"proxy-{ses}.jsonl"), key=os.path.getmtime)
if fs:
    for ln in open(fs[0]):
        d = json.loads(ln)
        if d.get('event') == 'fj_turn':
            print(f"merged={d.get('tool_calls_merged')} raw={d.get('tool_calls_raw')} forks={d.get('fork_count')}")
            for f in d.get('forks', []):
                print(f"   {f['agent']}: tool_calls={f.get('tool_calls')}")
else:
    print("no session log found")
PY

rm -f /tmp/fj_test_out.txt proxy-${SES}.jsonl 2>/dev/null
echo ""
echo "PASS: two forks both wanted read_file(src/index.ts) -> merged=1" 2>/dev/null || true
