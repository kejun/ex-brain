# Progress

## Status
Completed

## Tasks
- [x] 读取 brain-repo.ts 全文，列出所有方法及其职责分类
- [x] 分析各职责组之间的依赖关系
- [x] 设计拆分方案
- [x] 评估每个新 module 的 depth
- [x] 分析拆分后调用方需要的 adapter
- [x] 识别真正的 seam
- [x] 输出详细重构方案和实施路径

## Files Changed
- progress.md (updated)

## Notes
Completed deep analysis of BrainRepository God Object refactoring candidate.

---

# BrainRepository God Object 分析报告

## 1. 方法清单与职责分类

### 文件: `src/repositories/brain-repo.ts` (925 行)

| 职责组 | 方法 | 行数 | 描述 |
|--------|------|------|------|
| **CRUD** | `getPage(slug)` | 47-77 | 获取单个页面 |
| | `putPage(input, skipEmbed)` | 79-114 | 创建/更新页面 |
| | `listPages(filters)` | 116-159 | 列表查询 + 标签过滤 |
| | `deletePage(slug)` | 540-554 | 删除页面 + 级联清理 |
| | `allSlugs()` | 532-540 | 获取所有 slug |
| | `stats()` | 161-183 | 数据库统计 |
| **Search** | `search(query, limit, type)` | 185-225 | 混合搜索 (vector + text) |
| | `query(question, limit)` | 227-271 | 语义向量查询 |
| | `syncPageToSearch(slug)` | 279-310 | 同步单页到搜索索引 |
| | `syncPagesToSearch(slugs)` | 315-352 | 批量同步到搜索索引 |
| | `embedAll()` | 354-366 | 全量重新嵌入 |
| | `fallbackSearch(query, limit, type)` | 230-254 | SQL LIKE 回退搜索 (private) |
| | `recentBoost(updatedAt)` | 273-278 | 新鲜度加权 (private) |
| **Link** | `link(fromSlug, toSlug, context)` | 368-379 | 创建链接 |
| | `backlinks(slug)` | 508-521 | 获取反向链接 |
| | `outgoingLinks(slug)` | 523-535 | 获取正向链接 |
| **Timeline** | `timeline(slug, limit)` | 381-405 | 获取页面时间线 |
| | `timelineAdd(entry)` | 407-423 | 添加单条时间线 |
| | `timelineAddBatch(entries)` | 428-451 | 批量添加时间线 |
| | `timelineGlobal(limit)` | 456-480 | 全局时间线 |
| | `timelineDelete(id)` | 485-495 | 删除时间线条目 |
| | `timelineUpdate(id, updates)` | 497-506 | 更新时间线条目 |
| **Tag** | `tags(slug)` | 556-567 | 获取页面标签 |
| | `tag(slug, tag)` | 569-581 | 添加标签 |
| | `untag(slug, tag)` | 583-594 | 移除标签 |
| | `syncTagsFromFrontmatter(...)` | 602-629 | 从 frontmatter 同步标签 |
| **Raw Data** | `readRaw(slug, source)` | 631-656 | 读取原始数据 |
| | `writeRaw(slug, source, data)` | 658-670 | 写入原始数据 |
| **Entity** | `findSimilarSlug(candidate, name)` | 676-698 | 查找相似 slug (去重) |
| | `ensureEntityPage(...)` | 707-749 | 确保实体页面存在 |
| **AI Orchestration** | `compilePage(slug, newInfo, source, date, llm)` | 759-806 | 智能编译 (核心 AI 功能) |
| | `extractAndAddTimeline(...)` | 821-838 | AI 提取时间线 |
| | `ingestContent(...)` | 850-888 | 完整摄取管道 |

### 方法统计
- **总方法数**: 32 个
- **公开方法**: 30 个
- **私有方法**: 2 个 (fallbackSearch, recentBoost)
- **构造函数依赖**: 1 个 (`BrainDb`)

---

## 2. 职责组依赖关系分析

### 2.1 内部调用图

```
CRUD 层
  └─ putPage()
       ├─→ getPage() (检查是否存在)
       ├─→ syncPageToSearch() (索引更新)
       └─→ [外部] BrainDb.client.execute()

Search 层
  ├─ search()
  │    ├─→ fallbackSearch() (失败回退)
  │    └─→ [外部] BrainDb.pagesCollection.hybridSearch()
  ├─ query()
  │    ├─→ recentBoost() (新鲜度加权)
  │    └─→ [外部] BrainDb.pagesCollection.query()
  ├─ syncPageToSearch()
  │    ├─→ getPage() (获取页面内容)
  │    └─→ [外部] BrainDb.pagesCollection.upsert()
  ├─ syncPagesToSearch()
  │    ├─→ getPage() (批量获取)
  │    └─→ [外部] BrainDb.pagesCollection.upsert()
  └─ embedAll()
       ├─→ listPages() (全量加载)
       └─→ syncPagesToSearch() (批量同步)

Entity 层
  ├─ findSimilarSlug()
  │    ├─→ getPage() (精确匹配)
  │    └─→ search() (语义匹配)
  └─ ensureEntityPage()
       ├─→ getPage() (检查存在)
       └─→ putPage() (创建/更新)

AI Orchestration 层
  ├─ compilePage()
  │    ├─→ getPage() (获取当前页面)
  │    ├─→ putPage() (更新页面)
  │    ├─→ timeline() (获取历史时间线)
  │    ├─→ timelineAddBatch() (添加时间线)
  │    ├─→ syncPageToSearch() (更新索引)
  │    └─→ [外部] compileTruth() (AI 编译)
  ├─ extractAndAddTimeline()
  │    ├─→ timelineAddBatch()
  │    └─→ [外部] extractTimelineEvents() (AI 提取)
  └─ ingestContent()
       ├─→ compilePage() (核心编译)
       ├─→ getPage() (获取结果)
       ├─→ extractAndAddTimeline() (时间线提取)
       └─→ putPage() (类型更新)
```

### 2.2 共享状态

| 状态 | 访问者 | 读写类型 |
|------|--------|----------|
| `this.db` (BrainDb) | 所有方法 | 读 (通过 client/pagesCollection) |
| `pages` 表 | CRUD, Search, Entity, AI | 读写 |
| `links` 表 | Link, deletePage | 读写 |
| `timeline_entries` 表 | Timeline, AI, deletePage | 读写 |
| `page_tags` 表 | Tag, deletePage | 读写 |
| `raw_data` 表 | Raw Data, deletePage | 读写 |
| **Vector Collection** | Search, syncPageToSearch | 读写 |

### 2.3 关键依赖

1. **Search → CRUD**: `syncPageToSearch` 调用 `getPage` 获取内容
2. **Entity → CRUD + Search**: `findSimilarSlug` 调用 `getPage` + `search`
3. **AI → CRUD + Timeline + Search**: `compilePage` 调用 `getPage/putPage/timeline/timelineAddBatch/syncPageToSearch`
4. **deletePage → 所有子表**: 删除时级联清理

---

## 3. 拆分方案设计

### 3.1 推荐架构

```
src/repositories/
├── page-repo.ts          (~180 lines) — CRUD + 基础页面管理
├── search-index.ts       (~200 lines) — 搜索索引管理 (seam: 多后端支持)
├── link-manager.ts       (~80 lines)  — 链接管理
├── timeline-manager.ts    (~140 lines) — 时间线管理
├── tag-manager.ts        (~100 lines) — 标签管理
├── raw-data-manager.ts    (~60 lines)  — 原始数据管理
├── entity-resolver.ts    (~100 lines) — 实体解析与创建
├── ai-orchestrator.ts    (~150 lines) — AI 编译与摄取管道
└── brain-repo.ts         (~150 lines) — Facade (向后兼容层)
```

### 3.2 各模块详细设计

#### PageRepo (基础 CRUD)

```typescript
// src/repositories/page-repo.ts
export class PageRepo {
  constructor(private readonly db: BrainDb) {}

  // 核心方法
  async get(slug: string): Promise<PageRecord | null>
  async put(input: PutPageInput): Promise<PageRecord>
  async list(filters: { type?: string; tag?: string; limit?: number }): Promise<PageRecord[]>
  async delete(slug: string): Promise<void>
  async allSlugs(): Promise<string[]>
  async stats(): Promise<BrainStats>
  
  // 批量操作 (优化性能)
  async batchGet(slugs: string[]): Promise<PageRecord[]>
}
```

**Depth 评估**:
- **接口**: 6 个方法，参数简单
- **实现**: SQL 查询 + 结果映射 + 错误处理
- **Depth**: 🟢 **深** — 接口简洁，实现隐藏 SQL 细节、JSON 解析、错误包装

**职责**: 单一表 (pages) 的 CRUD，无外部依赖

---

#### SearchIndex (搜索索引管理) — **真正的 Seam**

```typescript
// src/repositories/search-index.ts
export interface SearchBackend {
  hybridSearch(query: string, options: SearchOptions): Promise<SearchHit[]>;
  vectorQuery(query: string, options: QueryOptions): Promise<SearchHit[]>;
  upsert(ids: string[], documents: string[], metas: object[]): Promise<void>;
}

export class SearchIndex {
  constructor(
    private readonly pageRepo: PageRepo,
    private readonly backend: SearchBackend,
  ) {}
  
  // 搜索
  async search(query: string, limit?: number, type?: string): Promise<SearchHit[]>
  async query(question: string, limit?: number): Promise<SearchHit[]>
  
  // 索引同步
  async syncPage(slug: string): Promise<void>
  async syncPages(slugs: string[]): Promise<void>
  async syncAll(): Promise<number>
  
  // 可选: 索引管理
  async clearIndex(): Promise<void>
  async rebuildIndex(): Promise<number>
}

// 后端实现
export class SeekdbSearchBackend implements SearchBackend {
  constructor(private readonly collection: Collection) {}
  // 实现 hybridSearch, vectorQuery, upsert
}

export class FallbackSearchBackend implements SearchBackend {
  constructor(private readonly pageRepo: PageRepo) {}
  // 实现 SQL LIKE 搜索
}
```

**Depth 评估**:
- **接口**: 5 个核心方法 + `SearchBackend` 抽象
- **实现**: 向量搜索 + SQL 回退 + 新鲜度加权 + 截断策略
- **Depth**: 🟢 **非常深** — 接口完全抽象了搜索后端

**关键 Seam 特征**:
1. **Two adapters = real seam**: `SeekdbSearchBackend` (向量搜索) + `FallbackSearchBackend` (SQL LIKE)
2. **可测试性**: 可以 mock `SearchBackend` 进行单元测试
3. **可扩展性**: 未来可添加 ElasticsearchBackend, PineconeBackend 等
4. **Deletion Test**: 如果删除 `SeekdbSearchBackend`，可以无缝切换到 `FallbackSearchBackend`

---

#### LinkManager

```typescript
// src/repositories/link-manager.ts
export class LinkManager {
  constructor(private readonly db: BrainDb) {}
  
  async create(from: string, to: string, context: string): Promise<void>
  async backlinks(slug: string): Promise<string[]>
  async outgoing(slug: string): Promise<Array<{ slug: string; context: string }>>
  async deleteForPage(slug: string): Promise<void>
  
  // 批量操作
  async batchCreate(links: Array<{ from: string; to: string; context: string }>): Promise<void>
}
```

**Depth 评估**:
- **接口**: 4 个方法
- **实现**: 单表 SQL 操作
- **Depth**: 🟡 **中等** — 接口和实现规模相当，但封装了 links 表的细节

---

#### TimelineManager

```typescript
// src/repositories/timeline-manager.ts
export class TimelineManager {
  constructor(private readonly db: BrainDb) {}
  
  async list(slug: string, limit?: number): Promise<TimelineEntry[]>
  async add(entry: TimelineEntry): Promise<void>
  async addBatch(entries: TimelineEntry[]): Promise<void>
  async global(limit?: number): Promise<TimelineEntry[]>
  async delete(id: number): Promise<void>
  async update(id: number, updates: Partial<TimelineEntry>): Promise<void>
  async deleteForPage(slug: string): Promise<void>
}
```

**Depth 评估**:
- **接口**: 6 个方法
- **实现**: 单表 SQL 操作 + 批量插入优化
- **Depth**: 🟡 **中等** — 类似 LinkManager，但 `addBatch` 提供了优化价值

---

#### TagManager

```typescript
// src/repositories/tag-manager.ts
export class TagManager {
  constructor(private readonly db: BrainDb) {}
  
  async list(slug: string): Promise<string[]>
  async add(slug: string, tag: string): Promise<void>
  async remove(slug: string, tag: string): Promise<void>
  async syncFromFrontmatter(slug: string, frontmatter: Record<string, unknown>): Promise<number>
  async deleteForPage(slug: string): Promise<void>
}
```

**Depth 评估**:
- **接口**: 5 个方法
- **实现**: 单表 SQL 操作 + frontmatter 同步逻辑
- **Depth**: 🟡 **中等** — `syncFromFrontmatter` 提供了有价值的业务逻辑

---

#### RawDataManager

```typescript
// src/repositories/raw-data-manager.ts
export class RawDataManager {
  constructor(private readonly db: BrainDb) {}
  
  async read(slug: string, source?: string): Promise<unknown[]>
  async write(slug: string, source: string, data: unknown): Promise<void>
  async deleteForPage(slug: string): Promise<void>
}
```

**Depth 评估**:
- **接口**: 3 个方法
- **实现**: 单表 SQL 操作 + JSON 序列化
- **Depth**: 🔴 **浅** — 几乎是直接 SQL 透传，但提供类型安全

---

#### EntityResolver

```typescript
// src/repositories/entity-resolver.ts
export class EntityResolver {
  constructor(
    private readonly pageRepo: PageRepo,
    private readonly searchIndex: SearchIndex,
  ) {}
  
  async findSimilarSlug(candidate: string, name: string): Promise<string>
  async ensurePage(
    slug: string,
    type: string,
    title: string,
    relation: string,
    context: string,
    sourceSlug: string,
  ): Promise<boolean>  // true = created, false = existed
}
```

**Depth 评估**:
- **接口**: 2 个方法
- **实现**: 实体去重 + 语义搜索 + 自动创建逻辑
- **Depth**: 🟢 **深** — 隐藏了复杂的实体消歧逻辑

---

#### AIOrchestrator

```typescript
// src/repositories/ai-orchestrator.ts
export class AIOrchestrator {
  constructor(
    private readonly pageRepo: PageRepo,
    private readonly timelineManager: TimelineManager,
    private readonly searchIndex: SearchIndex,
  ) {}
  
  async compilePage(
    slug: string,
    newInfo: string,
    source: string,
    date: string,
    llm: ResolvedLLM,
  ): Promise<CompileResult>
  
  async extractAndAddTimeline(
    slug: string,
    content: string,
    source: string,
    defaultDate: string,
    llm: ResolvedLLM,
  ): Promise<TimelineExtractionResult>
  
  async ingestContent(
    slug: string,
    content: string,
    source: string,
    type: string,
    llm: ResolvedLLM,
  ): Promise<IngestResult>
}
```

**Depth 评估**:
- **接口**: 3 个方法
- **实现**: 编排多个模块 + LLM 调用 + 结果聚合
- **Depth**: 🟢 **非常深** — 核心业务逻辑，封装了复杂的 AI 管道

---

### 3.3 Facade 层 (向后兼容)

```typescript
// src/repositories/brain-repo.ts (重构后)
export class BrainRepository {
  private readonly pageRepo: PageRepo;
  private readonly searchIndex: SearchIndex;
  private readonly linkManager: LinkManager;
  private readonly timelineManager: TimelineManager;
  private readonly tagManager: TagManager;
  private readonly rawDataManager: RawDataManager;
  private readonly entityResolver: EntityResolver;
  private readonly aiOrchestrator: AIOrchestrator;
  
  constructor(db: BrainDb) {
    this.pageRepo = new PageRepo(db);
    this.searchIndex = new SearchIndex(
      this.pageRepo,
      new SeekdbSearchBackend(db.pagesCollection),
    );
    this.linkManager = new LinkManager(db);
    this.timelineManager = new TimelineManager(db);
    this.tagManager = new TagManager(db);
    this.rawDataManager = new RawDataManager(db);
    this.entityResolver = new EntityResolver(this.pageRepo, this.searchIndex);
    this.aiOrchestrator = new AIOrchestrator(
      this.pageRepo,
      this.timelineManager,
      this.searchIndex,
    );
  }
  
  // 委托方法 (保持原有 API)
  getPage = (slug: string) => this.pageRepo.get(slug);
  putPage = (input: PutPageInput, skipEmbed?: boolean) => this.pageRepo.put(input, skipEmbed);
  // ... 其他委托方法
}
```

---

## 4. 深度评估总结

| 模块 | 接口复杂度 | 实现复杂度 | Depth | 价值判断 |
|------|-----------|-----------|-------|----------|
| **PageRepo** | 低 (6 方法) | 中 (SQL + 映射) | 🟢 深 | ✅ 值得拆分 |
| **SearchIndex** | 中 (5 方法 + Backend 接口) | 高 (向量 + SQL + 加权) | 🟢 非常深 | ✅ **核心 Seam** |
| **LinkManager** | 低 (4 方法) | 低 (单表 SQL) | 🟡 中等 | ✅ 拆分有价值 |
| **TimelineManager** | 低 (6 方法) | 中 (SQL + 批量) | 🟡 中等 | ✅ 拆分有价值 |
| **TagManager** | 低 (5 方法) | 中 (SQL + 同步) | 🟡 中等 | ✅ 拆分有价值 |
| **RawDataManager** | 低 (3 方法) | 低 (单表 SQL) | 🔴 浅 | ⚠️ 可选拆分 |
| **EntityResolver** | 低 (2 方法) | 中 (消歧 + 创建) | 🟢 深 | ✅ 值得拆分 |
| **AIOrchestrator** | 低 (3 方法) | 高 (多模块编排 + LLM) | 🟢 非常深 | ✅ **核心业务逻辑** |

---

## 5. 调用方 Adapter 分析

### 5.1 CLI 命令 (`src/commands/`)

当前所有命令直接依赖 `BrainRepository`:

```typescript
// 现状
await withRepo(program, async (repo: BrainRepository) => {
  const page = await repo.getPage(slug);
  // ...
});
```

**拆分后的两种选择**:

#### 选项 A: 保持 Facade (推荐)
CLI 继续使用 `BrainRepository`，内部委托到各模块。

**优点**: 零改动，向后兼容
**缺点**: Facade 仍然暴露全部接口

#### 选项 B: 直接依赖子模块
CLI 命令按需依赖具体模块:

```typescript
// 选项 B
await withRepo(program, async (db: BrainDb) => {
  const pageRepo = new PageRepo(db);
  const page = await pageRepo.get(slug);
  // ...
});
```

**优点**: 明确依赖，更好的模块边界
**缺点**: 需要修改所有命令

### 5.2 MCP Server (`src/mcp/server.ts`)

当前 MCP Server 创建 `BrainRepository` 并暴露 20+ 工具。

**拆分后**:
- 可以按功能组拆分 MCP 工具定义
- 例如: `search-tools.ts`, `page-tools.ts`, `timeline-tools.ts`
- 每组工具依赖对应模块

### 5.3 推荐策略

**第一阶段**: 保持 `BrainRepository` 作为 Facade，零破坏性改动

**第二阶段**: 逐步将 CLI 命令迁移到直接依赖子模块:
- 简单命令 (get, list, stats) → `PageRepo`
- 搜索命令 (search, query) → `SearchIndex`
- 时间线命令 → `TimelineManager`
- 标签命令 → `TagManager`
- 链接命令 → `LinkManager`

---

## 6. 真正的 Seam 识别

### 6.1 SearchIndex — Two Adapters = Real Seam

**Seam 定义**: 一个抽象接口，有多于一个实现，允许独立变化。

```typescript
// Seam 接口
interface SearchBackend {
  hybridSearch(query: string, options: SearchOptions): Promise<SearchHit[]>;
  vectorQuery(query: string, options: QueryOptions): Promise<SearchHit[]>;
  upsert(ids: string[], documents: string[], metas: object[]): Promise<void>;
}

// Adapter 1: Seekdb (向量搜索)
class SeekdbSearchBackend implements SearchBackend {
  constructor(private readonly collection: Collection) {}
  // 实现使用 seekdb 的向量搜索能力
}

// Adapter 2: SQL Fallback (纯文本搜索)
class FallbackSearchBackend implements SearchBackend {
  constructor(private readonly pageRepo: PageRepo) {}
  // 实现使用 SQL LIKE 搜索
}

// 使用者
class SearchIndex {
  constructor(
    private readonly pageRepo: PageRepo,
    private readonly backend: SearchBackend,  // 注入依赖
  ) {}
}
```

**Deletion Test 验证**:
- ✅ 删除 `SeekdbSearchBackend` → `FallbackSearchBackend` 继续工作
- ✅ 删除 `FallbackSearchBackend` → `SeekdbSearchBackend` 继续工作
- ✅ 可以在测试中注入 `MockSearchBackend`

### 6.2 其他潜在 Seam

| 候选 Seam | 当前实现数 | 是否真实 Seam | 分析 |
|-----------|-----------|--------------|------|
| `BrainDb` (数据库连接) | 1 (Seekdb) | ⚠️ 潜在 | 可支持 SQLite/PostgreSQL 适配器 |
| `LLMProvider` (AI 服务) | 1 (Ax adapter) | ⚠️ 潜在 | 可支持 OpenAI/Anthropic/Claude 适配器 |
| `DocumentLoader` (文档加载) | 1 (markdown/document-loader) | ⚠️ 潜在 | 可支持更多文档格式 |

---

## 7. 详细重构方案和实施路径

### 7.1 实施阶段

#### Phase 1: 基础设施准备 (Day 1)

**目标**: 创建共享类型和测试基础设施

1. 创建 `src/repositories/types.ts`
   ```typescript
   // 从 src/types/index.ts 迁移仓库相关类型
   export interface SearchOptions { ... }
   export interface QueryOptions { ... }
   export interface SearchResult { ... }
   ```

2. 创建 `src/repositories/search-backend.ts`
   ```typescript
   export interface SearchBackend { ... }
   export class SeekdbSearchBackend implements SearchBackend { ... }
   export class FallbackSearchBackend implements SearchBackend { ... }
   ```

3. 创建 `src/__tests__/repositories/` 测试目录

#### Phase 2: 拆分无依赖模块 (Day 2-3)

**顺序**: 无依赖 → 低依赖 → 高依赖

1. **RawDataManager** (无依赖)
   - 创建 `src/repositories/raw-data-manager.ts`
   - 迁移 `readRaw`, `writeRaw` 方法
   - 在 `BrainRepository` 中委托

2. **LinkManager** (无依赖)
   - 创建 `src/repositories/link-manager.ts`
   - 迁移 `link`, `backlinks`, `outgoingLinks` 方法

3. **TagManager** (无依赖)
   - 创建 `src/repositories/tag-manager.ts`
   - 迁移 `tags`, `tag`, `untag`, `syncTagsFromFrontmatter`

4. **TimelineManager** (无依赖)
   - 创建 `src/repositories/timeline-manager.ts`
   - 迁移 `timeline`, `timelineAdd`, `timelineAddBatch`, `timelineGlobal`, `timelineDelete`, `timelineUpdate`

#### Phase 3: 拆分基础 CRUD (Day 4)

5. **PageRepo** (无依赖)
   - 创建 `src/repositories/page-repo.ts`
   - 迁移 `getPage`, `putPage`, `listPages`, `deletePage`, `allSlugs`, `stats`
   - **注意**: `deletePage` 需要协调其他模块清理关联数据

6. **SearchIndex** (依赖 PageRepo)
   - 创建 `src/repositories/search-index.ts`
   - 迁移 `search`, `query`, `syncPageToSearch`, `syncPagesToSearch`, `embedAll`
   - 注入 `SearchBackend` 接口

#### Phase 4: 拆分高级功能 (Day 5)

7. **EntityResolver** (依赖 PageRepo, SearchIndex)
   - 创建 `src/repositories/entity-resolver.ts`
   - 迁移 `findSimilarSlug`, `ensureEntityPage`

8. **AIOrchestrator** (依赖 PageRepo, TimelineManager, SearchIndex)
   - 创建 `src/repositories/ai-orchestrator.ts`
   - 迁移 `compilePage`, `extractAndAddTimeline`, `ingestContent`
   - 注入 LLM 配置

#### Phase 5: 重构 BrainRepository (Day 6)

9. 重构 `BrainRepository` 为 Facade
   - 组合所有子模块
   - 保持所有现有方法签名
   - 委托到对应模块

#### Phase 6: 测试与验证 (Day 7)

10. 单元测试
    - 每个子模块独立测试
    - Mock 依赖项

11. 集成测试
    - 验证 Facade 行为不变
    - 运行现有测试套件

12. 性能测试
    - 验证无性能回退
    - 测量批量操作性能

### 7.2 具体文件结构

```
src/repositories/
├── types.ts                    (~50 lines) — 共享类型定义
├── search-backend.ts           (~100 lines) — SearchBackend 接口 + 适配器
├── page-repo.ts                (~180 lines) — PageRepo 类
├── search-index.ts             (~200 lines) — SearchIndex 类
├── link-manager.ts             (~80 lines)  — LinkManager 类
├── timeline-manager.ts         (~140 lines) — TimelineManager 类
├── tag-manager.ts              (~100 lines) — TagManager 类
├── raw-data-manager.ts         (~60 lines)  — RawDataManager 类
├── entity-resolver.ts          (~100 lines) — EntityResolver 类
├── ai-orchestrator.ts          (~150 lines) — AIOrchestrator 类
└── brain-repo.ts               (~200 lines) — Facade (向后兼容)
                                   总计: ~1260 lines (vs 原 925 lines)
```

**代码增长分析**:
- 原始: 925 行
- 重构后: ~1260 行 (+36%)
- 增长来源: 类型定义、接口定义、构造函数注入、import/export

### 7.3 测试策略

```typescript
// src/__tests__/repositories/search-index.test.ts
describe('SearchIndex', () => {
  it('should use SeekdbSearchBackend when available', async () => {
    const mockBackend = mock<SearchBackend>();
    const mockPageRepo = mock<PageRepo>();
    const searchIndex = new SearchIndex(mockPageRepo, mockBackend);
    
    mockBackend.hybridSearch.mockResolvedValue([...]);
    
    const results = await searchIndex.search('test query');
    
    expect(mockBackend.hybridSearch).toHaveBeenCalledWith('test query', expect.any(Object));
  });
  
  it('should fallback to SQL search when backend fails', async () => {
    const mockBackend = mock<SearchBackend>();
    const fallbackBackend = new FallbackSearchBackend(mockPageRepo);
    const searchIndex = new SearchIndex(mockPageRepo, mockBackend);
    
    mockBackend.hybridSearch.mockRejectedValue(new Error('Vector search failed'));
    
    const results = await searchIndex.search('test query');
    // 应该使用回退搜索
  });
});

// src/__tests__/repositories/ai-orchestrator.test.ts
describe('AIOrchestrator', () => {
  it('should compile page with LLM', async () => {
    const mockPageRepo = mock<PageRepo>();
    const mockTimelineManager = mock<TimelineManager>();
    const mockSearchIndex = mock<SearchIndex>();
    const mockLLM = { ... };
    
    const orchestrator = new AIOrchestrator(
      mockPageRepo,
      mockTimelineManager,
      mockSearchIndex,
    );
    
    mockPageRepo.get.mockResolvedValue(existingPage);
    
    const result = await orchestrator.compilePage('test-slug', 'new info', 'source', '2025-01-01', mockLLM);
    
    expect(result.changed).toBe(true);
    expect(mockPageRepo.put).toHaveBeenCalled();
    expect(mockTimelineManager.addBatch).toHaveBeenCalled();
    expect(mockSearchIndex.syncPage).toHaveBeenCalled();
  });
});
```

### 7.4 向后兼容策略

```typescript
// src/repositories/brain-repo.ts (Facade)
export class BrainRepository {
  // 私有子模块
  private readonly pageRepo: PageRepo;
  private readonly searchIndex: SearchIndex;
  // ... 其他模块
  
  constructor(db: BrainDb) {
    this.pageRepo = new PageRepo(db);
    this.searchIndex = new SearchIndex(
      this.pageRepo,
      new SeekdbSearchBackend(db.pagesCollection),
    );
    // ... 初始化其他模块
  }
  
  // 所有现有方法作为委托
  async getPage(slug: string): Promise<PageRecord | null> {
    return this.pageRepo.get(slug);
  }
  
  async putPage(input: PutPageInput, skipEmbed = false): Promise<PageRecord> {
    const page = await this.pageRepo.put(input);
    if (!skipEmbed) {
      await this.searchIndex.syncPage(input.slug);
    }
    return page;
  }
  
  // ... 其他委托方法
}
```

**关键点**:
1. 保持所有现有方法签名不变
2. 保持返回类型不变
3. 保持错误行为不变
4. CLI 和 MCP Server 零改动

### 7.5 性能优化机会

重构过程中顺便修复的性能问题:

1. **embedAll 使用批量方法**
   ```typescript
   // 现状: 串行调用 syncPageToSearch
   async embedAll(): Promise<number> {
     const pages = await this.listPages({ limit: 100000 });
     for (const page of pages) {
       await this.syncPageToSearch(page.slug);  // 串行!
     }
   }
   
   // 优化: 使用批量方法
   async syncAll(): Promise<number> {
     const pages = await this.pageRepo.list({ limit: 100000 });
     await this.searchIndex.syncPages(pages.map(p => p.slug));  // 批量!
     return pages.length;
   }
   ```

2. **timelineAddBatch 使用事务**
   ```typescript
   // 现状: 逐条插入
   async timelineAddBatch(entries: TimelineEntry[]): Promise<void> {
     const placeholders = entries.map(() => `(?, ?, ?, ?, ?, ?)`).join(', ');
     // 多行 INSERT
   }
   
   // 优化: 使用事务
   async addBatch(entries: TimelineEntry[]): Promise<void> {
     await this.db.transaction(async (tx) => {
       // 批量插入
     });
   }
   ```

3. **findSimilarSlug 跳过搜索优化**
   ```typescript
   // 在批量导入时跳过语义搜索
   async findSimilarSlug(candidate: string, name: string, options?: { skipSearch?: boolean }): Promise<string> {
     if (await this.pageRepo.get(candidate)) return candidate;
     if (options?.skipSearch) return candidate;  // 新增选项
     // ... 语义搜索
   }
   ```

---

## 8. 风险与缓解措施

### 8.1 风险清单

| 风险 | 严重程度 | 缓解措施 |
|------|---------|---------|
| 破坏现有行为 | 🔴 高 | 保持 Facade + 完整测试覆盖 |
| 性能回退 | 🟠 中 | 基准测试 + 优化批量操作 |
| 循环依赖 | 🟠 中 | 严格的依赖方向: PageRepo → SearchIndex → EntityResolver → AIOrchestrator |
| 测试覆盖不足 | 🟠 中 | 重构前补充测试 |
| Facade 层变成新的 God Object | 🟡 低 | 逐步将 CLI 迁移到直接依赖子模块 |

### 8.2 回滚计划

如果重构导致严重问题:
1. Git revert 到重构前版本
2. 恢复原始 `brain-repo.ts`
3. 由于保持了所有公开接口，回滚零破坏

---

## 9. 总结

### 关键发现

1. **BrainRepository 确实是 God Object**: 32 个方法，8 大类职责，925 行代码
2. **SearchIndex 是真正的 Seam**: 可以支持 Seekdb 和 SQL Fallback 两种后端
3. **AIOrchestrator 是核心业务逻辑**: 编排 PageRepo + TimelineManager + SearchIndex + LLM
4. **依赖图清晰**: PageRepo (基础) → SearchIndex (中层) → EntityResolver/AIOrchestrator (高层)

### 拆分收益

1. **可测试性**: 每个模块可以独立测试，mock 依赖
2. **可扩展性**: SearchIndex 可以支持多种后端 (Elasticsearch, Pinecone, etc.)
3. **可维护性**: 每个模块 <200 行，单一职责
4. **性能优化**: 拆分后更容易优化批量操作

### 下一步行动

1. **立即**: 创建 `src/repositories/types.ts` 和 `search-backend.ts`
2. **短期**: 拆分 RawDataManager, LinkManager, TagManager, TimelineManager
3. **中期**: 拆分 PageRepo, SearchIndex
4. **长期**: 拆分 EntityResolver, AIOrchestrator，迁移 CLI 到直接依赖

---

*Generated by QuickLion (ex-brain main)*
