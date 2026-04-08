#!/bin/bash
# Benchmark for ebrain put and import performance
# Primary metric: import_10_with_entities_ns (lower is better)

set -e

DB_PATH="/tmp/ebrain-bench/test.db"
CLI="bun run $(pwd)/src/cli.ts"

# Cleanup
rm -rf /tmp/ebrain-bench 2>/dev/null || true
mkdir -p /tmp/ebrain-bench

# Initialize
$CLI --db "$DB_PATH" init 2>/dev/null || true

# Test 1: Single put (simple content, no entities)
start=$(python3 -c "import time; print(int(time.time() * 1e9))")
echo "Simple content without entities" | $CLI --db "$DB_PATH" put --stdin 2>/dev/null || true
end=$(python3 -c "import time; print(int(time.time() * 1e9))")
echo "METRIC put_simple_ns=$((end - start))"

# Test 2: Single put (content with entities)
start=$(python3 -c "import time; print(int(time.time() * 1e9))")
echo "阿里巴巴创始人马云在杭州创立了这家公司。" | $CLI --db "$DB_PATH" put --stdin --title "公司信息" 2>/dev/null || true
end=$(python3 -c "import time; print(int(time.time() * 1e9))")
echo "METRIC put_with_entities_ns=$((end - start))"

# Test 3: Import 10 simple files
IMPORT_DIR1=$(mktemp -d)
for i in {1..10}; do
  cat > "$IMPORT_DIR1/note-$i.md" << EOF
---
title: Note $i
type: note
tags:
  - benchmark
---

This is benchmark note number $i.
EOF
done

start=$(python3 -c "import time; print(int(time.time() * 1e9))")
$CLI --db "$DB_PATH" import "$IMPORT_DIR1" 2>/dev/null || true
end=$(python3 -c "import time; print(int(time.time() * 1e9))")
echo "METRIC import_10_files_ns=$((end - start))"

# Test 4: Import 10 files with entities (PRIMARY)
IMPORT_DIR2=$(mktemp -d)
for i in {1..10}; do
  cat > "$IMPORT_DIR2/entity-$i.md" << EOF
---
title: Entity Note $i
type: note
---

张三和李四合作开发了项目$i。王五投资了这个项目。
EOF
done

start=$(python3 -c "import time; print(int(time.time() * 1e9))")
$CLI --db "$DB_PATH" import "$IMPORT_DIR2" 2>/dev/null || true
end=$(python3 -c "import time; print(int(time.time() * 1e9))")
echo "METRIC import_10_with_entities_ns=$((end - start))"

# Cleanup
rm -rf "$IMPORT_DIR1" "$IMPORT_DIR2"
rm -rf /tmp/ebrain-bench 2>/dev/null || true