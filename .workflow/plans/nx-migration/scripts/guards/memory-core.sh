#!/usr/bin/env bash
# Guard for state memory-core (legacy P7). Red->green. Captures $? directly.
set -u
ROOT="${ROOT:-/Users/nix/dev/ai/sox-ecosystem}"
cd "$ROOT" || exit 1

pnpm exec nx run memory-core:build >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: memory-core build"; exit 1; }
pnpm exec nx run-many -t build --projects=memory-server,memory-organizer,memory-flush,memory-cli,sox-memory-bundle >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: memory extensions build"; exit 1; }
out=$(grep -rEl '\.\./.*dist/' extensions --include=*.ts 2>/dev/null); [ -z "$out" ]; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: cross-extension reach-in remains: $out"; exit 1; }
pnpm exec nx run-many -t lint --projects=memory-server,memory-organizer,memory-flush,memory-cli >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: boundary lint"; exit 1; }
T="$ROOT/.tmp-guard-mem"; rm -rf "$T"; mkdir -p "$T"
node -e "const {write,recall}=require('./libs/memory-core/dist/index');const db='$T/project.db';write(db,{content:'nx migration test memory entry',agent_id:'test'});const r=recall(db,{query:'nx migration',limit:1});process.exit(r.length>0?0:1)"; rc=$?; rm -rf "$T"; [ $rc -eq 0 ] || { echo "FAIL: C5 write+recall"; exit 1; }
echo "memory-core: PASS"
exit 0
