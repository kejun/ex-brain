#!/bin/bash
# Benchmark for ebrain put and import performance
# Measures time for data ingestion operations
# Note: seekdb may segfault on exit (code 139), but output is valid

set -e

DB_PATH="/tmp/ebrain-bench/test.db"
CLI="bun run $(pwd)/src/cli.ts"

# Cleanup
rm -rf /tmp/ebrain-bench 2>/dev/null || true
mkdir -p /tmp/ebrain-bench

# Initialize (ignore segfault from seekdb - output is still valid)
$CLI --db "$DB_PATH" init 2>/dev/null || true

# Test 1: Single put (simple content, no entities) - baseline
start=$(python3 -c "import time; print(int(time.time() * 1e9))")
echo "Simple content without entities" | $CLI --db "$DB_PATH" put --stdin 2>/dev/null || true
end=$(python3 -c "import time; print(int(time.time() * 1e9))")
echo "METRIC put_simple_ns=$((end - start))"

# Test 2: Single put (content with entities - triggers LLM)
start=$(python3 -c "import time; print(int(time.time() * 1e9))")
echo "阿里巴巴创始人马云在杭州创立了这家公司，蔡崇信也是联合创始人。" | $CLI --db "$DB_PATH" put --stdin --title "公司信息" 2>/dev/null || true
end=$(python3 -c "import time; print(int(time.time() * 1e9))")
echo "METRIC put_with_entities_ns=$((end - start))"

# Test 3: Import 10 markdown files (tests batch performance)
IMPORT_DIR=$(mktemp -d)
for i in {1..10}; do
  cat > "$IMPORT_DIR/note-$i.md" << EOF
---
title: Note $i
type: note
tags:
  - benchmark
---

This is benchmark note number $i. It contains some content about topic $i.
The quick brown fox jumps over the lazy dog.
EOF
done

start=$(python3 -c "import time; print(int(time.time() * 1e9))")
$CLI --db "$DB_PATH" import "$IMPORT_DIR" 2>/dev/null || true
end=$(python3 -c "import time; print(int(time.time() * 1e9))")
echo "METRIC import_10_files_ns=$((end - start))"

# Test 4: Import 10 files with entities (triggers LLM for each)
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
rm -rf "$IMPORT_DIR" "$IMPORT_DIR2"
rm -rf /tmp/ebrain-bench 2>/dev/null || true