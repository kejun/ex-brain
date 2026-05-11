# ex-brain 适用场景说明文档

> ex-brain 是一个基于 seekdb 的个人知识库 CLI 工具，核心能力包括：智能编译（Smart Compilation）、时间线管理、实体链接、混合搜索、知识图谱可视化、文档摄取和 MCP Server。本文档全面梳理其适用场景。

---

## 一、场景总览

| 编号 | 场景分类 | 核心能力 | 典型用户 |
|------|----------|----------|----------|
| S1 | 个人知识管理 | 页面管理、混合搜索、标签 | 所有用户 |
| S2 | 公司动态追踪 | 智能编译、时间线 | 投资人/分析师 |
| S3 | 项目文档管理 | 文档摄取、编译 | 项目经理/技术负责人 |
| S4 | 会议与日程管理 | 时间线提取、事件记录 | 所有用户 |
| S5 | 人物关系网络 | 实体链接、知识图谱 | HR/投资人/研究员 |
| S6 | 研究资料整理 | 批量导入、混合搜索 | 研究员/学生 |
| S7 | 新闻与信息聚合 | 智能编译、来源追溯 | 信息分析者 |
| S8 | AI 辅助问答（RAG） | LLM 查询、上下文检索 | 所有用户 |
| S9 | AI Agent 集成 | MCP Server | 开发者 |
| S10 | 多格式文档处理 | PDF/Word/HTML/URL 摄取 | 所有用户 |
| S11 | 数据备份与导出 | 导出、原始数据追溯 | 所有用户 |
| S12 | 自动化流水线 | CLI 管道、脚本集成 | 开发者/运维 |

---

## 二、场景详述

### S1 — 个人知识管理

**问题**：笔记散落在多处，难以检索和关联。

**方案**：
- 使用 `ebrain put` 写入笔记，按 `type/slug` 分类
- 使用 `ebrain search` / `ebrain query` 进行全文+语义混合搜索
- 使用 `ebrain tag add` 给页面打标签，支持按标签过滤

```bash
# 记录一条技术笔记
ebrain put notes/golang-goroutine --type note --file goroutine.md

# 搜索相关知识
ebrain search "goroutine 最佳实践"
ebrain query "Go 语言并发模型的核心设计是什么？"

# 给页面打标签
ebrain tag add notes/golang-goroutine go
ebrain tag add notes/golang-goroutine concurrency

# 按标签查找
ebrain list --tag go
```

**适用人群**：需要管理大量个人笔记、技术文档、学习记录的所有用户。

---

### S2 — 公司动态追踪

**问题**：跟踪公司/项目的最新进展（融资、人事变动、产品发布）时，信息容易堆积、旧信息无法自动更新。

**方案**：ex-brain 的核心能力 — **智能编译（Smart Compilation）** 自动区分信息类型并更新：

| 信息类型 | 处理方式 | 示例 |
|----------|----------|------|
| 状态更新 | 替换旧值，旧值归档到 History | 融资阶段 Seed → Series A |
| 事实信息 | 追加并持久保留 | 成立于 2020 年 |
| 事件信息 | 记录到时间线 | 发布了新产品 X |
| 纠正信息 | 替换并标记冲突 | CEO 从 A 换成 B |

```bash
# 初始页面
ebrain put companies/river-ai --type company --content "Funding Stage: Seed"

# 智能编译新融资信息
ebrain compile companies/river-ai \
  "River AI 完成 A 轮融资，红杉资本领投，5000 万美元" \
  --source news --date 2024-05-20

# 结果：
# - Compiled Truth: Seed → Series A（旧值归档到 History）
# - Timeline 新增一条融资事件
# - 来源标注：(Source: news, 2024-05-20)

# 智能编译 CEO 更换
ebrain compile companies/river-ai \
  "Sarah Chen 加入担任 CEO，接替 John Doe" \
  --source press_release --date 2024-06-15

# 查看时间线
ebrain timeline list companies/river-ai
```

**适用人群**：VC/PE 投资人、行业分析师、创业者、商业情报人员。

---

### S3 — 项目文档管理

**问题**：项目相关资料（PRD、技术方案、会议纪要）散落在不同位置，缺乏统一视图。

**方案**：
- 使用 `ebrain put` 直接写入 Markdown 文件
- 使用 `ebrain ingest` 自动摄取 PDF/Word/HTML 文档
- 使用 `ebrain smart-ingest` 一次性完成编译 + 时间线 + 实体链接

```bash
# 写入 PRD 文档
ebrain put projects/alpha-prd --type project --file prd.md

# 摄取 PDF 技术方案
ebrain ingest technical-design.pdf --slug projects/alpha-tech

# 智能摄取（完整 AI 处理链路）
ebrain smart-ingest projects/alpha-launch --file weekly-report.md --source weekly_report

# 查看项目时间线
ebrain timeline extract projects/alpha-launch
```

**适用人群**：项目经理、技术负责人、产品经理。

---

### S4 — 会议与日程管理

**问题**：会议记录中的关键事件和决策难以追踪，时间线不清晰。

**方案**：
- 使用 `ebrain timeline add` 手动记录事件
- 使用 `ebrain timeline extract` AI 自动从文本提取时间线事件
- 使用 `ebrain timeline list` 查看全局时间线

```bash
# 创建会议记录页面
ebrain put meetings/2024-05-20 --type note --file meeting.md

# 从会议记录中提取关键事件
ebrain timeline extract meetings/2024-05-20

# 手动添加重要决策
ebrain timeline add projects/alpha \
  --date 2024-05-20 \
  --summary "决定采用 Go 作为后端语言" \
  --source meeting

# 全局时间线视图
ebrain timeline list --limit 20
```

**适用人群**：需要追踪项目里程碑、会议决策、历史事件的任何人。

---

### S5 — 人物关系网络

**问题**：人员之间、公司与人物之间的关系复杂，难以可视化。

**方案**：
- 使用 `ebrain link` 建立实体间关系
- 使用 `ebrain backlinks` 查看反向链接
- 使用 `ebrain graph` 启动知识图谱可视化

```bash
# 创建人物页面
ebrain put people/sarah-chen --type person --file sarah.md
ebrain put companies/river-ai --type company --file river.md

# 建立关系
ebrain link people/sarah-chen companies/river-ai --context "CEO"

# 查看反向链接
ebrain backlinks companies/river-ai

# 启动知识图谱可视化
ebrain graph                    # http://localhost:3000
ebrain graph --port 8080 --open # 自定义端口并自动打开浏览器
```

**适用人群**：HR、投资人（追踪创始人与公司关系）、研究员。

---

### S6 — 研究资料整理

**问题**：研究过程中收集的资料量大、格式多样，整理和检索困难。

**方案**：
- 使用 `ebrain import` 批量导入整个目录
- 使用 `ebrain search` 混合搜索（全文 + 向量语义）
- 使用 `ebrain query` 纯语义查询

```bash
# 批量导入研究资料目录
ebrain import ./research-papers --dry-run    # 先预览
ebrain import ./research-papers               # 正式导入

# 混合搜索（关键词匹配 + 语义匹配）
ebrain search "transformer 模型架构" --limit 10

# 纯语义查询
ebrain query "transformer 模型的核心创新是什么？"
```

**适用人群**：学术研究员、研究生、情报分析人员。

---

### S7 — 新闻与信息聚合

**问题**：日常阅读的新闻、博客、报告中包含有价值的信息，但难以整合到已有知识体系中。

**方案**：
- 使用 `ebrain compile` 将碎片信息智能编译到已有页面
- 每条信息自动标注来源，支持溯源
- 关键事件自动记录到时间线

```bash
# 编译新闻片段到公司页面
ebrain compile companies/river-ai \
  "River AI 发布新一代 AI 编码助手，支持 20 种编程语言" \
  --source tech_news --date 2024-07-01

# 编译行业报告
ebrain compile companies/river-ai \
  "2024 年 AI 编程工具市场规模预计达 $50B，River AI 市占率 3%" \
  --source industry_report --date 2024-08-15
```

**适用人群**：市场分析师、行业观察者、信息收集者。

---

### S8 — AI 辅助问答（RAG）

**问题**：知识库内容丰富，但需要快速定位并获取综合性回答。

**方案**：使用 `ebrain query --llm` 进行 RAG（检索增强生成）问答：

```bash
# 自然语言问答
ebrain query --llm "River AI 的主要产品是什么？"
ebrain query --llm "哪些公司最近完成了融资？"
ebrain query --llm "Q4 发生了哪些重要事件？"

# 控制上下文深度
ebrain query --llm "Sarah Chen 的职业经历是怎样的？" --context-limit 3
```

**工作流程**：
1. **语义搜索** — 找到与问题最匹配的页面
2. **多层上下文收集** — 页面内容 + 时间线 + 关联页面
3. **LLM 合成回答** — 生成带 `[[slug|title]]` 引用的回答

**配置**：在 `~/.ebrain/settings.json` 中配置 LLM：
```json
{
  "llm": {
    "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "model": "qwen-plus",
    "apiKey": "sk-..."
  }
}
```

**适用人群**：需要快速从知识库中获取答案的所有用户。

---

### S9 — AI Agent 集成（MCP Server）

**问题**：希望 AI Agent（如 Claude Desktop）能够直接读写知识库。

**方案**：启动 `ebrain serve` MCP Server，为 AI Agent 提供 20+ 工具：

```bash
# 启动 MCP Server
ebrain serve

# 指定数据库路径
ebrain serve --db /path/to/custom.db
```

**MCP 工具列表**：

| 工具 | 功能 |
|------|------|
| `brain_get` | 获取页面内容 |
| `brain_put` | 创建/更新页面 |
| `brain_delete` | 删除页面 |
| `brain_search` | 全文混合搜索 |
| `brain_query` | 向量语义查询 |
| `brain_compile` | 智能编译新信息 |
| `brain_smart_ingest` | 完整智能摄取 |
| `brain_ingest` | 简单文本摄取 |
| `brain_ingest_document` | PDF/Word/HTML/URL 摄取 |
| `brain_link` | 创建实体链接 |
| `brain_backlinks` | 查看反向链接 |
| `brain_timeline` | 查看页面时间线 |
| `brain_timeline_add` | 添加时间线条目 |
| `brain_timeline_list` | 全局时间线 |
| `brain_timeline_delete` | 删除时间线条目 |
| `brain_timeline_extract` | AI 提取时间线 |
| `brain_tags` | 查看页面标签 |
| `brain_tag` | 添加/移除标签 |
| `brain_list` | 列出页面（可过滤） |
| `brain_stats` | 知识库统计 |
| `brain_raw` | 读写原始数据 |

**Claude Desktop 配置**：
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

**适用人群**：使用 Claude Desktop 或其他 MCP 客户端的开发者、AI 重度用户。

---

### S10 — 多格式文档处理

**问题**：资料包含 PDF、Word、HTML 等多种格式，手动提取文本再导入效率低。

**方案**：`ebrain ingest` 和 `ebrain put --file` 支持自动格式检测和文本提取：

| 格式 | 扩展名 | 解析器 |
|------|--------|--------|
| PDF | `.pdf` | unpdf (PDF.js) |
| Word | `.docx` | mammoth |
| HTML | `.html` | 内置标签剥离 |
| JSON | `.json` | JSON.stringify |
| Markdown | `.md` | UTF-8 直接读取 |
| 纯文本 | `.txt`/`.csv`/`.log` | UTF-8 直接读取 |
| 远程 URL | `http(s)://` | 自动检测 Content-Type |

```bash
# 本地文件
ebrain ingest report.pdf
ebrain ingest meeting-notes.docx
ebrain ingest article.html

# 远程 URL
ebrain ingest https://example.com/whitepaper.pdf
ebrain ingest https://example.com/article --format html

# 自定义 slug 和类型
ebrain ingest report.pdf --slug docs/q4-report --type research-paper

# put 命令也支持多格式
ebrain put docs/api --file api.md
ebrain put docs/report --file report.pdf
```

**自动保存的元数据**：
- `sourceFile` / `sourceType` / `sourceKind` / `sourceMimeType` / `sourceBytes`
- 自动添加时间线条目：`Ingested <kind> <fileName>`
- 原始数据记录到 `raw_data` 表，可追溯

**适用人群**：处理多种文档格式的所有用户。

---

### S11 — 数据备份与导出

**问题**：需要备份知识库数据，或导出数据用于其他用途。

**方案**：
- 数据库文件位于 `~/.ebrain/data/ebrain.db`，可直接复制备份
- 使用 `ebrain export` 导出数据
- 使用 `ebrain raw` 查看原始来源数据

```bash
# 查看统计信息
ebrain stats

# 查看原始数据
ebrain raw get companies/river-ai news

# 导出（如果支持）
ebrain export
```

**适用人群**：所有需要数据安全和可移植性的用户。

---

### S12 — 自动化流水线

**问题**：需要将知识库操作集成到脚本、CI/CD 或自动化工作流中。

**方案**：CLI 支持管道输入、JSON 输出和程序化调用：

```bash
# 管道输入
cat notes.md | ebrain put notes/daily --stdin
curl -s https://api.example.com/data | ebrain raw set my/page --source api --stdin

# JSON 输出（供脚本处理）
ebrain get companies/river-ai --json | jq '.compiledTruth'
ebrain list --type company --json | jq '.[] | .slug'

# Dry-run 预览
ebrain put --file report.pdf --dry-run
ebrain import ./docs --dry-run

# 配合脚本自动化
#!/bin/bash
for file in ./clippings/*.md; do
  slug=$(basename "$file" .md)
  ebrain compile "notes/$slug" "$(cat "$file")" --source clipping
done
```

**适用人群**：开发者、运维工程师、需要自动化知识管理的用户。

---

## 三、场景组合示例

### 场景组合 A：投资尽调工作流

```
1. 初始化公司页面
   ebrain put companies/target-co --type company --file company-intro.md

2. 批量导入尽调资料
   ebrain import ./due-diligence/

3. 智能编译访谈记录
   ebrain compile companies/target-co "CTO 表示团队 80 人，研发占比 70%" --source interview

4. 建立实体关系
   ebrain link people/founder-name companies/target-co --context "Founder & CEO"
   ebrain link companies/target-co companies/competitor-x --context "competes_with"

5. AI 问答总结
   ebrain query --llm "Target Co 的团队规模和研发投入如何？"

6. 知识图谱可视化
   ebrain graph --open

7. 通过 AI Agent 持续更新
   # Claude Desktop MCP 自动调用 brain_compile 更新信息
```

### 场景组合 B：个人学习知识库

```
1. 初始化
   ebrain init

2. 收藏网页文章
   # 使用 MarkSnip 浏览器插件剪藏为 Markdown
   cat article.md | ebrain put notes/article-slug --stdin

3. 摄取 PDF 论文
   ebrain ingest research-paper.pdf --slug papers/slug --type research-paper

4. 智能整理
   ebrain smart-ingest topics/machine-learning --file textbook-chapter.md

5. 建立知识关联
   ebrain link papers/paper1 topics/machine-learning --context "基于该理论"

6. 检索与问答
   ebrain search "attention mechanism"
   ebrain query --llm "解释 transformer 的 self-attention 机制"

7. 查看时间线
   ebrain timeline list topics/machine-learning
```

### 场景组合 C：会议与项目管理

```
1. 创建项目页面
   ebrain put projects/alpha --type project --file project-brief.md

2. 记录会议纪要
   ebrain put meetings/2024-05-20 --type note --file meeting.md

3. 提取关键事件
   ebrain timeline extract meetings/2024-05-20
   ebrain timeline add projects/alpha --date 2024-05-20 --summary "完成技术选型"

4. 编译进度更新
   ebrain compile projects/alpha "MVP 已完成，进入 Beta 测试" --source weekly_report

5. 全局时间线查看
   ebrain timeline list --limit 50
```

---

## 四、技术架构概览

```
┌─────────────────────────────────────────────────┐
│                   用户界面                       │
│  CLI (ebrain) │ MCP Server │ Web UI (Graph)     │
├─────────────────────────────────────────────────┤
│                  命令层                          │
│  put │ get │ search │ query │ compile │ timeline │
│  link │ tag │ import │ export │ ingest │ graph  │
├─────────────────────────────────────────────────┤
│                  仓库层                          │
│          BrainRepository (brain-repo.ts)         │
├──────────────────┬──────────────────────────────┤
│      AI 层       │        数据层                │
│  Ax Signature    │    seekdb (嵌入式数据库)      │
│  GEPA 优化       │    向量索引 (KNN)            │
│  智能编译        │    全文索引                   │
│  时间线提取      │    原始数据表                 │
│  实体链接        │                               │
├──────────────────┴──────────────────────────────┤
│                  嵌入层                          │
│     Hash (本地) │ OpenAI Compatible (API)       │
└─────────────────────────────────────────────────┘
```

---

## 五、快速选型指南

| 你的需求 | 使用命令 |
|----------|----------|
| 写入笔记 | `ebrain put <slug> --file <path>` |
| 更新已有知识（智能） | `ebrain compile <slug> <info> --source <src>` |
| 一步到位（编译+时间线+链接） | `ebrain smart-ingest <slug> --file <path>` |
| 处理 PDF/Word 文档 | `ebrain ingest <file>` |
| 搜索知识 | `ebrain search <query>` |
| 语义问答 | `ebrain query <question>` |
| AI 问答（LLM 合成） | `ebrain query --llm <question>` |
| 查看/提取时间线 | `ebrain timeline list` / `extract` |
| 建立实体关系 | `ebrain link <from> <to> --context <desc>` |
| 可视化知识图谱 | `ebrain graph` |
| AI Agent 集成 | `ebrain serve` |
| 批量导入 | `ebrain import <dir>` |

---

## 六、与同类工具对比

| 能力 | ex-brain | Obsidian | Notion | Logseq |
|------|----------|----------|--------|--------|
| 本地优先 | ✅ | ✅ | ❌ | ✅ |
| 智能编译（自动更新知识） | ✅ | ❌ | ❌ | ❌ |
| 时间线自动提取 | ✅ | ❌ | ❌ | ❌ |
| 实体关系图谱 | ✅ | 插件 | ❌ | 基础 |
| 混合搜索（全文+语义） | ✅ | 插件 | 全文 | 全文 |
| MCP Server（AI Agent） | ✅ | 插件 | ❌ | ❌ |
| CLI 自动化 | ✅ | ❌ | ❌ | ❌ |
| 多格式文档摄取 | ✅ | 手动 | 手动 | 手动 |
| AI 自动实体链接 | ✅ | ❌ | ❌ | ❌ |
| 开源 | ✅ | ❌ | ❌ | ✅ |

---

*文档版本: v1.0 | 更新日期: 2026-05-11*
