# Timeline & Compiled Truth 核心能力实现

## 架构概述

本实现完善了 ex-brain 的两大核心能力：

1. **智能编译 (Smart Compilation)** - 分析新信息语义，智能更新 compiled truth
2. **时间线管理 (Timeline Management)** - 从非结构化文本提取事件，记录历史

> **v0.2.3 更新**: AI 模块已全面升级为 Ax Signature + GEPA 框架，替换了所有手写 prompt。

## 新增文件

### `src/ai/compiler.ts`
核心编译器（基于 Ax Signature），提供：
- `compileTruth()` - 智能编译函数
- 信息类型分类: status_update, new_event, correction, confirmation, new_entity
- 智能合并逻辑: 追加、更新、替换、冲突处理
- 自动时间线提取
- Ax `f.json()` 结构化输出，支持多行 markdown

### `src/ai/timeline-extractor.ts`
时间线提取器（基于 Ax Signature），提供：
- `extractTimelineEvents()` - 事件提取函数
- 多格式日期解析: ISO, 中文, 英文月份, 相对日期
- LLM 语义提取 + Regex 备用方案
- 事件重要性分级
- Ax `f.json()` 结构化输出，支持中文日期解析

### `src/commands/compile-cmd.ts`
CLI 命令：
- `ebrain compile <slug> <info>` - 智能编译新信息
- `ebrain smart-ingest` - 完整智能摄取

## 更新文件

### `src/repositories/brain-repo.ts`
新增方法：
- `compilePage()` - 页面智能编译
- `extractAndAddTimeline()` - 提取并添加时间线
- `ingestContent()` - 完整摄取流程
- `timelineAddBatch()` - 批量添加时间线
- `timelineGlobal()` - 全局时间线视图
- `timelineDelete()` - 删除时间线条目
- `timelineUpdate()` - 更新时间线条目

### `src/mcp/server.ts`
新增 MCP 工具：
- `brain_compile` - 智能编译工具
- `brain_smart_ingest` - 完整摄取工具
- `brain_timeline_list` - 全局时间线列表
- `brain_timeline_delete` - 删除时间线条目
- `brain_timeline_extract` - 提取时间线事件

## 使用示例

### 用例: River AI A轮融资

```bash
# 1. 创建初始页面 (种子轮状态)
echo "Funding Stage: Seed" | ebrain put companies/river-ai --type company --stdin

# 2. 编译新信息: A轮融资
ebrain compile companies/river-ai \
  "River AI closed Series A funding of $50M" \
  --source meeting_notes \
  --date 2024-05-20

# 结果:
# - Compiled Truth 更新: Seed → Series A
# - Timeline 添加: "River AI closed Series A funding"
# - 自动添加来源标注
```

### 用例: CEO 更换

```bash
# 编译新信息: CEO 更换
ebrain compile companies/river-ai \
  "Sarah Chen joined as CEO, replacing John Doe" \
  --source press_release \
  --date 2024-06-15

# 结果:
# - Compiled Truth 更新: CEO: John Doe → Sarah Chen
# - Timeline 添加: "Sarah Chen joined as CEO"
# - 保留历史: John Doe 的信息移到 History 部分
```

### MCP 工具调用 (Claude/AI 使用)

```json
// 调用 brain_compile 工具
{
  "slug": "companies/river-ai",
  "new_info": "River AI closed Series A funding",
  "source": "meeting_notes",
  "date": "2024-05-20"
}

// 返回结果
{
  "ok": true,
  "changed": true,
  "changeType": "update",
  "changeSummary": "Updated funding stage from Seed to Series A",
  "timelineEntriesAdded": 1,
  "confidence": 0.85
}
```

## 信息处理流程

```
新信息输入
    ↓
┌─────────────────────────┐
│  1. 信息分析 (LLM)       │
│  - 分类信息类型          │
│  - 提取关键事实          │
│  - 识别更新/追加         │
└─────────────────────────┘
    ↓
┌─────────────────────────┐
│  2. 智能合并             │
│  - 追加新事实            │
│  - 更新状态信息          │
│  - 保留历史记录          │
│  - 添加来源标注          │
└─────────────────────────┘
    ↓
┌─────────────────────────┐
│  3. 时间线提取           │
│  - 识别关键事件          │
│  - 提取日期信息          │
│  - 创建时间线条目        │
└─────────────────────────┘
    ↓
┌─────────────────────────┐
│  4. 写入数据库           │
│  - 更新 compiled_truth   │
│  - 添加 timeline_entries │
│  - 同步搜索索引          │
└─────────────────────────┘
```

## Compiled Truth 结构示例

```markdown
## Status
- **Funding Stage**: Series A (Source: meeting_notes, 2024-05-20)
- **Valuation**: ~$50M (Source: meeting_notes, 2024-05-20)
- **CEO**: Sarah Chen (Source: press_release, 2024-06-15)

## History
- Previously: Seed stage (until 2024-05-20)
- Previously: John Doe as CEO (until 2024-06-15)

## Facts
- Series A led by Sequoia Capital
- Founded in 2020
```

## Timeline Entries 结构

```json
[
  {
    "date": "2024-05-20",
    "source": "meeting_notes",
    "summary": "River AI closed Series A funding ($50M)",
    "detail": "Led by Sequoia Capital"
  },
  {
    "date": "2024-06-15",
    "source": "press_release",
    "summary": "Sarah Chen joined as CEO",
    "detail": "Replacing John Doe who moved to advisory role"
  }
]
```

## 设计原则

### 1. 信息时效性
- 状态信息 (funding_stage, ceo) → **可更新**
- 事实信息 (founded_year, industry) → **持久保留**
- 事件信息 (product_launch, funding_closed) → **记录到 timeline**

### 2. 来源可追溯
每条信息都有来源标注: `(Source: meeting_notes, 2024-05-20)`
- 旧信息虽然从 compiled truth 中消失，仍存在于 timeline 中

### 3. 语义理解
使用 LLM 分析信息类型:
- `status_update` → 更新/替换
- `new_event` → 追加 + timeline
- `correction` → 替换 + 冲突标注
- `confirmation` → 仅更新置信度

### 4. 历史保留
关键状态变化会在 `## History` 部分保留:
- 不丢失历史信息
- 可追溯状态演变

## 测试覆盖

```bash
# 运行编译器测试
bun test src/ai/compiler.test.ts

# 运行完整测试
bun test
```

## 未来扩展

1. **冲突检测**: 当新信息与旧信息矛盾时的处理
2. **信息衰减**: 长时间未更新的信息的置信度衰减
3. **关联更新**: 某个实体的信息变化触发相关实体更新
4. **批量编译**: 批量处理多个相关信息片段
