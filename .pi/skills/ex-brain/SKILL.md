---
name: ex-brain
description: CLI 个人知识库工具，支持智能编译、时间线管理、实体链接、混合检索。当用户需要管理知识笔记、编译信息、建立实体关联、时间线提取、或启动 MCP Server 时使用此 skill。
---

# ex-brain

本地优先的个人知识库 CLI，基于 seekdb 构建。核心能力：**智能编译**新信息、**自动提取时间线**、**实体关联**、**混合检索**。

## 安装

```bash
bun install -g ex-brain
# 或
npm install -g ex-brain

# 初始化数据库（创建 ~/.ebrain/data/ebrain.db）
ebrain init
```

## 配置

编辑 `~/.ebrain/settings.json`：

```jsonc
{
  "db": { "path": "~/.ebrain/data/ebrain.db" },
  "embed": {
    "provider": "hash",              // 或 "openai_compatible"
    "baseURL": "...",                // 嵌入 API 地址
    "model": "text-embedding-v4",
    "dimensions": 1024,
    "apiKey": "",
    "apiKeyEnv": "DASHSCOPE_API_KEY" // 从环境变量读取
  },
  "llm": {
    "baseURL": "...",                // LLM API 地址
    "model": "qwen-plus",
    "apiKeyEnv": "DASHSCOPE_API_KEY"
  }
}
```

运行 `ebrain config` 查看当前配置。

## 核心命令

### 页面管理

```bash
# 写入页面（幂等 upsert）
ebrain put <slug> --file <path>
ebrain put <slug> --stdin           # 管道输入
ebrain put <slug> --type <type> --content "内容"

# 获取页面
ebrain get <slug>
ebrain get <slug> --json            # JSON 输出

# 列出页面
ebrain list [--type person] [--tag yc] [--limit 50]

# 删除页面
ebrain delete <slug> [--dry-run]    # 预览模式
```

### 智能编译（核心功能）

智能编译会分析新信息、更新 Compiled Truth、提取时间线事件：

```bash
ebrain compile <slug> <info> --source <source> --date <date>

# 示例
ebrain compile companies/river-ai \
  "River AI 上了 A 轮，Sequoia 领投，5000万" \
  --source meeting_notes \
  --date 2024-05-20
```

编译结果：
- 状态信息（融资阶段、CEO）→ **更新**，旧值归档到 History
- 事实信息（成立年份、行业）→ **追加**保留
- 事件信息 → **记录到时间线**

### 时间线

```bash
# 查看页面时间线
ebrain timeline list <slug>

# 从页面内容提取时间线事件（LLM 语义提取）
ebrain timeline extract <slug>

# 手动添加时间线事件
ebrain timeline add <slug> --date YYYY-MM-DD --summary "..."
```

### 检索

```bash
# 全文搜索 + 向量语义检索（混合）
ebrain search <query> [--type person] [--limit 10]

# 纯语义查询
ebrain query <question> [--limit 10]

# 示例
ebrain search "River AI 融资"
ebrain query "哪些公司最近融资了？"
```

### 实体链接

```bash
# 创建链接（幂等）
ebrain link <from_slug> <to_slug> --context "关系描述"

# 查看反向链接
ebrain backlinks <slug>
```

### 标签

```bash
ebrain tag list <slug>
ebrain tag add <slug> <tag>         # 幂等
ebrain tag remove <slug> <tag>
```

### 知识图谱可视化

```bash
ebrain graph                        # 启动在 localhost:3000
ebrain graph --port 8080 --open     # 指定端口并打开浏览器
```

### MCP Server

```bash
ebrain serve                        # 启动 MCP Server
ebrain serve --db /path/to/db       # 指定数据库路径
```

## MCP 配置

在 Claude Desktop 或其他 MCP 客户端中配置：

```json
{
  "mcpServers": {
    "ebrain": {
      "command": "ebrain",
      "args": ["serve"]
    }
  }
}
```

### MCP 工具列表

| 工具 | 功能 |
|-----|------|
| `brain_get` | 获取页面内容 |
| `brain_put` | 创建/更新页面 |
| `brain_search` | 混合检索 |
| `brain_query` | 语义查询 |
| `brain_compile` | 智能编译新信息 |
| `brain_link` | 创建实体链接 |
| `brain_timeline_list` | 查看时间线 |
| `brain_timeline_extract` | 提取时间线事件 |

## Slug 命名规范

使用 `{type}/{name}` 格式：

- `companies/river-ai`
- `people/sarah-chen`
- `projects/alpha-launch`
- `notes/meeting-2024-05-20`

类型：`company`, `person`, `project`, `organization`, `event`, `note`, `other`

## 最佳实践

### 1. 编译优于追加

遇到新信息时，优先用 `compile` 而不是直接 `put`：

```bash
# 好：让系统智能处理
ebrain compile companies/river-ai "新信息" --source news

# 避免：简单追加（信息会膨胀）
ebrain put companies/river-ai --content "追加的内容"
```

### 2. 信息来源标注

始终标注信息来源，便于追溯：

```bash
ebrain compile companies/river-ai "信息" \
  --source meeting_notes \
  --date 2024-05-20
```

### 3. 类型分类

写入页面时指定类型，便于筛选：

```bash
ebrain put companies/river-ai --type company --file notes.md
ebrain put people/sarah-chen --type person --content "..."
```

### 4. 使用管道输入

适合脚本和自动化：

```bash
cat notes.md | ebrain put my/note --stdin
curl -s https://api.example.com/data | ebrain raw set my/page --source api --stdin
```

### 5. JSON 输出供程序处理

```bash
ebrain get companies/river-ai --json | jq '.compiledTruth'
ebrain list --type company --json | jq '.[] | .slug'
```

## 数据模型

- `pages`：知识页面（slug、type、title、compiled_truth、timeline）
- `links`：实体关联（from_slug、to_slug、context）
- `timeline_entries`：时间线事件（date、source、summary、detail）
- `page_tags`：页面标签
- `raw_data`：原始数据存储
- `ebrain_pages`（向量集合）：用于语义检索

## 技术栈

- **数据库**：seekdb（嵌入式数据库）
- **运行时**：Bun 或 Node.js
- **嵌入**：本地 Hash 或 OpenAI Compatible API
- **LLM**：用于智能编译、时间线提取、实体链接

## 参考

- [seekdb 文档](https://docs.seekdb.ai/)
- [详细 CLI 文档](../../../docs/ebrain-cli.md)
- [时间线与编译机制](../../../docs/timeline-compiled-truth.md)
- [知识图谱命令](../../../docs/graph-command.md)