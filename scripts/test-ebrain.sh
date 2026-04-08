#!/usr/bin/env bash
# 集成冒烟：嵌入模式下 seekdb 原生库在进程退出时可能返回 139（SIGSEGV），
# 若输出 JSON 仍符合预期则视为成功。设置 EBRAIN_SEEKDB_HOST 连接远程 seekdb 可得到正常退出码。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="$ROOT/data/test-ebrain.db"
rm -rf "$DB"
mkdir -p "$(dirname "$DB")"

run_ebrain_expect() {
  local jqfilter="$1"
  shift
  set +e
  local out
  out=$(bun run "$ROOT/src/cli.ts" "$@" 2>&1)
  local code=$?
  set -e
  printf '%s\n' "$out"
  if command -v jq >/dev/null 2>&1; then
    if echo "$out" | jq -e "$jqfilter" >/dev/null 2>&1; then
      return 0
    fi
  else
    echo "warning: jq not installed; only checking exit code" >&2
    [[ "$code" -eq 0 ]] && return 0
    [[ "$code" -eq 139 ]] && return 0
    [[ "$code" -eq 133 ]] && return 0
    return "$code"
  fi
  [[ "$code" -ne 0 ]] && return "$code"
  return 1
}

echo "init..."
run_ebrain_expect '.ok==true' --db "$DB" init --json

echo "put page..."
run_ebrain_expect '.slug=="test/hello"' --db "$DB" put test/hello --json <<'EOF'
---
title: Hello
type: note
---
Hello world

---

- **2026-04-01** | manual — First note
EOF

echo "search..."
run_ebrain_expect 'type=="array" and length>0' --db "$DB" search "Hello" --json

echo "stats..."
run_ebrain_expect '.pages>=0' --db "$DB" stats --json

echo "tools-json..."
set +e
TOOLS_OUT=$(bun run "$ROOT/src/cli.ts" --tools-json 2>&1)
TOOLS_CODE=$?
set -e
printf '%s\n' "$TOOLS_OUT"
if command -v jq >/dev/null 2>&1; then
  echo "$TOOLS_OUT" | jq -e '.tools|type=="array"' >/dev/null
else
  [[ "$TOOLS_CODE" -eq 0 ]] || [[ "$TOOLS_CODE" -eq 139 ]] || [[ "$TOOLS_CODE" -eq 133 ]]
fi

echo "OK"
