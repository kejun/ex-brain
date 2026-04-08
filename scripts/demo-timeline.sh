#!/bin/bash
# Demo: Timeline and Compiled Truth Workflow
# Shows how the system handles information updates

set -e

echo "=== Timeline & Compiled Truth Demo ==="
echo ""

# 1. 初始化数据库
echo "1. 初始化数据库..."
bun run src/cli.ts init --db data/demo.db

# 2. 创建初始公司页面
echo ""
echo "2. 创建 River AI 公司页面 (初始状态: 种子轮)..."
bun run src/cli.ts put companies/river-ai --db data/demo.db \
  --type company \
  --title "River AI" \
  --content "## Status\n\n- **Funding Stage**: Seed\n- **Founded**: 2020\n- **Industry**: AI/ML\n\n## Key People\n\n- CEO: John Doe\n\n## Facts\n\n- Seed funding of $5M in 2020"

# 3. 查看初始状态
echo ""
echo "3. 查看初始 Compiled Truth:"
bun run src/cli.ts get companies/river-ai --db data/demo.db --json | jq '.compiledTruth'

# 4. 编译新信息: A轮融资
echo ""
echo "4. 编译新信息: 'River AI 刚刚完成了 A 轮融资'..."
bun run src/cli.ts compile companies/river-ai \
  "River AI just closed Series A funding round of $50M, led by Sequoia Capital" \
  --source meeting_notes \
  --date 2024-05-20 \
  --db data/demo.db

# 5. 查看更新后的状态
echo ""
echo "5. 查看更新后的 Compiled Truth:"
bun run src/cli.ts get companies/river-ai --db data/demo.db --json | jq '.compiledTruth'

# 6. 查看 Timeline
echo ""
echo "6. 查看 Timeline (应该包含融资事件):"
bun run src/cli.ts timeline list companies/river-ai --db data/demo.db --json

# 7. 添加另一个信息: 新 CEO
echo ""
echo "7. 编译另一条信息: 'Sarah Chen 加入担任 CEO'..."
bun run src/cli.ts compile companies/river-ai \
  "Sarah Chen joined as CEO, replacing John Doe who moved to advisory role" \
  --source press_release \
  --date 2024-06-15 \
  --db data/demo.db

# 8. 最终状态
echo ""
echo "8. 最终 Compiled Truth (CEO 更新, 融资阶段更新):"
bun run src/cli.ts get companies/river-ai --db data/demo.db --json | jq '.compiledTruth'

echo ""
echo "9. 最终 Timeline (两个事件):"
bun run src/cli.ts timeline list companies/river-ai --db data/demo.db --json

# 10. 统计信息
echo ""
echo "10. 数据库统计:"
bun run src/cli.ts stats --db data/demo.db --json

echo ""
echo "=== Demo 完成 ==="