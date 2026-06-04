# ex-brain 实际数据示例

用一个完整的企业场景，展示一个 `slug` 对应的 **所有数据**。

---

## 场景：`companies/river-ai`

### 1. pages 表（一行 = 一个页面核心）

| 字段 | 值 |
|---|---|
| **slug** | `companies/river-ai` |
| type | `company` |
| title | River AI |
| compiled_truth | （见下方 Markdown） |
| timeline | `（空，timeline 在独立表中）` |
| frontmatter | `{"source":"web_article","sourceType":"company","_contentHash":"a1b2c3..."}` |
| created_at | `2025-01-15T10:30:00Z` |
| updated_at | `2025-05-18T14:22:00Z` |

**`compiled_truth` 的实际内容**（存储在 `pages.compiled_truth` 列中）：

```markdown
## 公司简介

River AI 是一家专注于企业级 AI 解决方案的科技公司，成立于 2023 年，总部位于上海。

## 融资历程

- **种子轮**：2023 年 3 月，获得 500 万元天使投资，投资方为真格基金
- **A 轮**：2025 年 1 月，获得 5000 万元 A 轮融资，由红杉资本领投

## 核心团队

- **CEO**：张三，前阿里巴巴技术总监，2023 年创立 River AI
- **CTO**：李四，前 Google 研究员，2024 年 6 月加入

## 产品

- **River Copilot**：企业级 AI 助手，2024 年 9 月正式发布
- **River Platform**：AI 开发平台，预计 2025 年 Q2 发布
```

> 这就是 `pages` 表中的 **唯一一行**。`slug` 是主键，整个页面的"本质"就是这段 `compiled_truth`。

---

### 2. timeline_entries 表（该页面的时间线事件）

该 slug 对应 **多条** 时间线记录：

| id | page_slug | date | source | summary | detail | importance |
|---|---|---|---|---|---|---|
| 1 | `companies/river-ai` | 2023-01-15 | founder_story | River AI 公司在上海成立 | 张三离开阿里巴巴，与两位联合创始人一起创立公司 | 5 |
| 2 | `companies/river-ai` | 2023-03-20 | news | 完成 500 万元种子轮融资 | 真格基金领投，资金用于产品研发 | 4 |
| 3 | `companies/river-ai` | 2024-06-15 | announcement | CTO 李四加入 | 李四此前在 Google 从事 NLP 研究 | 3 |
| 4 | `companies/river-ai` | 2024-09-01 | product_launch | River Copilot 正式发布 | 面向企业客户的 AI 助手产品 | 4 |
| 5 | `companies/river-ai` | 2025-01-10 | news | 完成 5000 万元 A 轮融资 | 红杉资本领投，用于市场扩张和团队建设 | 5 |

> 一个 slug 可以对应 **多条** `timeline_entries`。

---

### 3. links 表（实体关系）

**出射链接**（River AI 指向其他实体）：

| from_slug | to_slug | context | created_at |
|---|---|---|---|
| `companies/river-ai` | `people/zhang-san` | founder_of — 张三创立 River AI | 2025-01-15T10:30:00Z |
| `companies/river-ai` | `people/li-si` | works_at — 李四担任 CTO | 2025-01-15T10:30:00Z |
| `companies/river-ai` | `companies/sequoia` | invested_in — 红杉资本投资 River AI | 2025-01-15T10:30:00Z |
| `companies/river-ai` | `projects/river-copilot` | part_of — River Copilot 是旗下产品 | 2025-01-15T10:30:00Z |

**入射链接**（其他实体指向 River AI）：

| from_slug | to_slug | context |
|---|---|---|
| `people/zhang-san` | `companies/river-ai` | founded — 张三创立了这家公司 |
| `people/li-si` | `companies/river-ai` | works_at — 李四在此任职 |
| `companies/sequoia` | `companies/river-ai` | portfolio — 红杉的投资组合 |

---

### 4. page_tags 表（标签）

| page_slug | tag | created_at |
|---|---|---|
| `companies/river-ai` | `ai` | 2025-01-15T10:30:00Z |
| `companies/river-ai` | `b2b` | 2025-01-15T10:30:00Z |
| `companies/river-ai` | `series-a` | 2025-01-15T10:30:00Z |

---

### 5. raw_data 表（原始摄入记录）

| id | page_slug | source | data | fetched_at |
|---|---|---|---|---|
| 1 | `companies/river-ai` | web_article_2025-01 | `{ "url": "https://...", "html": "...", "text_length": 3200 }` | 2025-01-15T10:30:00Z |
| 2 | `companies/river-ai` | meeting_notes | `{ "meeting": "2025-03-01 sync", "notes": "..." }` | 2025-03-01T15:00:00Z |
| 3 | `companies/river-ai` | news_feed | `{ "title": "River AI 完成 A 轮", "content": "..." }` | 2025-01-10T09:00:00Z |

> 这是"偶性"——原始素材，可能包含噪声。每次摄入都保留一条。

---

### 6. seekdb 向量集合（语义搜索索引）

| 字段 | 值 |
|---|---|
| **id** | `companies/river-ai` |
| **document** | `"River AI\n\n## 公司简介\n\nRiver AI 是一家专注于企业级 AI 解决方案..."` （截断至 8000 字符） |
| **metadata** | `{"slug":"companies/river-ai","title":"River AI","type":"company","updatedAt":"2025-05-18T14:22:00Z"}` |
| **embedding** | `[0.023, -0.041, 0.018, ...]` （1024 维向量） |

---

## 总览：一个 slug 对应的数据全景

```
slug = "companies/river-ai"
  │
  ├─ pages            → 1 行   （本质：compiled_truth）
  ├─ timeline_entries → 5 行   （时间线事件）
  ├─ links (出射)     → 4 行   （指向其他实体）
  ├─ links (入射)     → 3 行   （被其他实体指向）
  ├─ page_tags        → 3 行   （标签）
  ├─ raw_data         → 3 行   （原始摄入记录）
  └─ seekdb vector    → 1 条   （语义搜索索引）
```

> **`slug` = 页面的主键 = 聚合根（Aggregate Root）**
>
> 所有以上数据通过 `page_slug` / `from_slug` / `to_slug` 关联回这个 slug，
> 共同构成 "River AI" 这个知识实体的完整表示。

---

## 页面 Markdown 格式（导入/导出视图）

当用户通过 `ebrain get companies/river-ai --markdown` 导出时，得到：

```markdown
---
title: River AI
type: company
source: web_article
sourceType: company
tags:
  - ai
  - b2b
  - series-a
---

## 公司简介

River AI 是一家专注于企业级 AI 解决方案的科技公司，成立于 2023 年，总部位于上海。

## 融资历程

- **种子轮**：2023 年 3 月，获得 500 万元天使投资，投资方为真格基金
- **A 轮**：2025 年 1 月，获得 5000 万元 A 轮融资，由红杉资本领投

## 核心团队

- **CEO**：张三，前阿里巴巴技术总监，2023 年创立 River AI
- **CTO**：李四，前 Google 研究员，2024 年 6 月加入

## 产品

- **River Copilot**：企业级 AI 助手，2024 年 9 月正式发布
- **River Platform**：AI 开发平台，预计 2025 年 Q2 发布

---

- **2023-01-15** | founder_story — River AI 公司在上海成立
- **2023-03-20** | news — 完成 500 万元种子轮融资
- **2024-06-15** | announcement — CTO 李四加入
- **2024-09-01** | product_launch — River Copilot 正式发布
- **2025-01-10** | news — 完成 5000 万元 A 轮融资
```

当分隔线 `---` 后面紧跟 `- **YYYY-MM-DD** | source — summary` 形式的时间线条目时，分隔线之上是 `compiled_truth`，之下是 `timeline`。普通 Markdown 水平线会保留在正文中；文件开头的 `---` 只有包含 YAML key（如 `title:`）时才会被识别为 frontmatter。
解析规则见 `src/markdown/parser.ts` 的 `parsePageMarkdown()` 与 `splitCompiledAndTimeline()`。
