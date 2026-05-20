# ex-brain 实现 ↔ 本体论 映射

本文档将 ex-brain 的当前代码实现与本体论（Ontology）核心概念逐一映射，帮助理解系统的设计哲学和数据结构背后的理论依据。

---

## 一、核心本体（Entities / 实体）

| 本体论概念 | 对应实现 | 说明 |
|---|---|---|
| **实体 (Entity)** | `pages` 表，以 `slug` 为唯一标识 | 每个 slug 代表一个独立存在的"事物"，如 `companies/river-ai`、`people/sarah-chen` |
| **实体类型 (Type)** | `pages.type` 字段 | `person` / `company` / `project` / `organization` / `event` / `note` / `other` —— 对应本体论的"范畴分类" |
| **实体名称 (Name)** | `pages.title` 字段 | 实体的可读标识 |
| **实体标识 (Identity)** | `slug` (主键) | 实体的唯一身份，类似于本体论中的"个体化原则" |

**代码对应：**
```
src/types/index.ts          → PageRecord, PageType
src/db/schema.ts            → CREATE TABLE pages (...)
src/repositories/brain-repo.ts → getPage, putPage, listPages
```

---

## 二、属性 (Properties / Attributes)

| 本体论概念 | 对应实现 | 说明 |
|---|---|---|
| **属性 (Property)** | `pages.frontmatter` (JSON) | 实体的元数据属性，如 source、date、autoCreated 等 |
| **本质属性 (Essence)** | `pages.compiled_truth` | 经过 AI 编译、去伪存真后的"核心事实"——接近本体论中的"本质" |
| **偶性属性 (Accident)** | `raw_data` 表 | 原始、未加工的摄入数据，可能包含噪声，会随时间累积 |

**关键区别：**
- `compiled_truth` = **本质**（经过 LLM 分析后保留的核心事实）
- `raw_data` = **偶性**（原始素材，随时间变化但不影响核心认知）

**代码对应：**
```
src/ai/compiler.ts     → compileTruth() — LLM 决定 update/append/replace
src/db/schema.ts       → raw_data 表 — 存储原始摄入
```

---

## 三、关系 (Relations)

| 本体论概念 | 对应实现 | 说明 |
|---|---|---|
| **关系 (Relation)** | `links` 表 `(from_slug, to_slug, context)` | 实体之间的关联，如 "张三 —founder_of→ River AI" |
| **关系类型** | 由 `entity-link.ts` 定义 | `founder_of` / `works_at` / `leader_of` / `collaborates_with` / `competes_with` / `acquired` / `part_of` / `invested_in` / `mentioned_in` / `related_to` |
| **入射关系** | `backlinks(slug)` | 指向该实体的关系 |
| **出射关系** | `outgoingLinks(slug)` | 该实体指向其他实体的关系 |

**代码对应：**
```
src/ai/entity-link.ts         → extractRelations(), EntityRelation 类型
src/db/schema.ts              → CREATE TABLE links (...)
src/repositories/brain-repo.ts → link(), backlinks(), outgoingLinks()
```

---

## 四、时间与变化 (Temporality)

| 本体论概念 | 对应实现 | 说明 |
|---|---|---|
| **事件 (Event)** | `timeline_entries` 表 | 发生在时间轴上的离散事件 |
| **时间 (Time)** | `timeline_entries.date` (YYYY-MM-DD) + 自动归一化 | 支持中文日期、英文日期、相对日期（yesterday/last week）的归一化 |
| **重要性** | `timeline_entries.importance` (1-5) | 事件的重要程度 |
| **持久化** | `pages.created_at` / `pages.updated_at` | 实体自身的创建/更新时间 |
| **历史 (History)** | timeline 的累积 + `compiled_truth` 的旧值被替换后自然消失 | 历史通过时间线保留，被替换的事实不再出现在 compiled_truth 中 |

**代码对应：**
```
src/ai/timeline-extractor.ts   → extractTimelineEvents(), normalizeDate()
src/db/schema.ts               → CREATE TABLE timeline_entries (...)
src/repositories/brain-repo.ts → timeline(), timelineAdd(), timelineAddBatch(), timelineGlobal()
```

---

## 五、认知与知识 (Epistemology)

| 本体论概念 | 对应实现 | 说明 |
|---|---|---|
| **知识 (Knowledge)** | `compiled_truth` + `timeline` | 经过 AI 编译后形成的"已验证真相" |
| **认知过程** | `compileTruth()` 的 LLM Pipeline | 新信息 → 与现有知识对比 → 判断 changeType → 更新真相 |
| **认知类型** | `changeType`: `append` / `update` / `replace` / `conflict` / `none` | 反映认知状态的变化方式 |
| **置信度** | `confidence` (0-1) | 对认知结果的信心程度 |
| **证据来源** | `source` 字段 + `raw_data` 表 | 知识的溯源，对应认识论中的"证成"(justification) |
| **信念修正** | `compileTruth()` 的 `replace` 操作 | 旧信念被新证据推翻，对应信念修正理论 (Belief Revision) |

**代码对应：**
```
src/ai/compiler.ts              → compileTruth(), CompileResult
src/ai/ax-pipeline.ts           → AIPipeline — LLM 调用生命周期封装
src/repositories/brain-repo.ts  → compilePage()
```

---

## 六、搜索与发现 (Search & Discovery)

| 本体论概念 | 对应实现 | 说明 |
|---|---|---|
| **语义相似性** | `seekdb` 的向量集合 `pagesCollection` | 通过 embedding 衡量概念间的语义距离 |
| **文本匹配** | SQL LIKE fallback | 传统的关键词匹配 |
| **混合检索** | `hybridSearch()` — 全文 + 向量 | 两种认知方式的结合 |
| **上下文扩展** | `query --llm` 的多层 context 收集 | page content + raw documents + linked pages |

**代码对应：**
```
src/ai/embed-factory.ts         → createBrainEmbeddingFunction()
src/ai/hash-embed.ts            → LocalHashEmbeddingFunction (本地确定性向量)
src/repositories/brain-repo.ts  → search(), query(), syncPageToSearch()
```

---

## 七、整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    本体层 (Ontology Layer)                    │
│                                                             │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐             │
│   │  Entity  │────│ Relation │────│  Entity  │   ← 实体 & 关系 │
│   │  (Page)  │    │  (Link)  │    │  (Page)  │             │
│   └────┬─────┘    └──────────┘    └────┬─────┘             │
│        │                               │                    │
│        ▼                               ▼                    │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐             │
│   │Properties│    │ Timeline │    │Properties│   ← 属性 & 事件 │
│   │(compiled │    │(Events)  │    │(compiled │             │
│   │ _truth)  │    │          │    │ _truth)  │             │
│   └──────────┘    └──────────┘    └──────────┘             │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                    认知层 (Epistemic Layer)                   │
│                                                             │
│   新信息 ──► compileTruth() ──► changeType 判断             │
│              ├─ append    (追加事实)                         │
│              ├─ update    (修正属性)                         │
│              ├─ replace   (替换本质)                         │
│              ├─ conflict  (发现矛盾)                         │
│              └─ none      (无变化)                           │
│                                                             │
│   新信息 ──► extractTimeline() ──► TimelineEntry             │
│   新信息 ──► extractRelations() ──► EntityRelation           │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                    存储层 (Persistence Layer)                 │
│                                                             │
│   pages │ links │ timeline_entries │ raw_data │ page_tags    │
│                                                             │
│   + seekdb vector collection (语义搜索)                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 八、当前缺失的本体论维度

从本体论完整性来看，当前实现**尚未显式建模**的维度：

1. **层级分类 (Taxonomy / Hierarchy)** — 当前 type 是扁平枚举，缺少 `is-a` 层级（如 `company → tech_company → AI_company`）

2. **部分-整体关系 (Mereology)** — 缺少 `part-of` 的结构化表达（如部门属于公司、章节属于文档）

3. **状态/生命周期 (States)** — 实体缺少显式状态机（如 company 的 `founded → active → acquired → defunct`）

4. **模态/可能性 (Modality)** — 无法表达"可能""必然""假设"等模态知识（如"River AI 可能明年上市"）

5. **属性类型系统 (Typed Properties)** — `compiled_truth` 是自由文本 Markdown，而非结构化属性槽 (slot)，无法做属性级查询

6. **同一性判定 (Identity Criteria)** — 当前 slug 由人工指定，缺少基于属性匹配的自动实体消歧（如识别"张三"和"Zhang San"是否为同一人）

这些是未来可以探索的方向。

---

## 九、核心代码文件索引

| 模块 | 文件路径 | 职责 |
|---|---|---|
| 类型定义 | `src/types/index.ts` | PageRecord, TimelineEntry, SearchHit 等核心类型 |
| 数据库模式 | `src/db/schema.ts` | 6 张表的 DDL 定义 |
| 仓储层 | `src/repositories/brain-repo.ts` | 实体 CRUD、搜索、编译、时间线、关系的全部操作 |
| AI 编译 | `src/ai/compiler.ts` | compileTruth — 智能知识编译 Pipeline |
| 时间线提取 | `src/ai/timeline-extractor.ts` | extractTimelineEvents — 事件抽取与日期归一化 |
| 实体关系 | `src/ai/entity-link.ts` | extractRelations — 实体关系抽取与 slug 生成 |
| AI Pipeline | `src/ai/ax-pipeline.ts` | AIPipeline — LLM 调用生命周期封装 |
| Embedding | `src/ai/embed-factory.ts` | 向量嵌入工厂（Hash / OpenAI Compatible） |
| CLI 命令 | `src/commands/` | compile, put, search, query, timeline, graph, link 等命令 |
