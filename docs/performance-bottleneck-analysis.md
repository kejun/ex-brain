# 性能瓶颈分析报告
## Task-4: Batch Import 与 Entity Extraction

---

## 1. Batch Import Entity Extraction 并行策略

### 当前实现
- **文件**: `src/commands/index.ts` (import 命令)
- **Batch Size**: 10 (常量 `BATCH_SIZE = 10`)
- **并行方式**: 使用 `Promise.all` 批量并行提取

```typescript
// Phase 3: Parallel entity extraction (main optimization)
const BATCH_SIZE = 10;
for (let i = 0; i < fileData.length; i += BATCH_SIZE) {
  const batch = fileData.slice(i, i + BATCH_SIZE).filter(d => d.tags.length === 0);
  const batchPromises = batch.map(async ({ slug, content }) => {
    const relations = await extractRelations(content, settings.llm);
    return { slug, relations };
  });
  const results = await Promise.all(batchPromises);
  // ...
}
```

### 瓶颈分析
| 问题 | 严重程度 | 描述 |
|------|----------|------|
| Batch 内串行过滤 | 低 | `.filter(d => d.tags.length === 0)` 在每批次中过滤，可能导致某些批次实际处理数量少于 BATCH_SIZE |
| 无标签文件优先处理 | 中 | 跳过有 tags 的文件可能是有意义的优化（假设有标签的不需要实体链接），但可能导致实体提取不完整 |
| LLM 调用延迟 | 高 | 每个 batch 等待所有 LLM 请求完成，LLM 响应时间是主要瓶颈 |

### 优化建议
1. **动态 Batch Size**: 根据 LLM 响应时间动态调整 batch size
2. **错误容忍**: 添加单个文件失败的容错机制，不要因为一个失败而中断整个批次
3. **预过滤优化**: 考虑在 Phase 1 过滤，减少 Phase 3 迭代次数

---

## 2. applyEntityLinks 串行循环

### 当前实现
- **文件**: `src/commands/index.ts`
- **处理方式**: for...of 串行循环

```typescript
for (const r of highConfidence) {
  // 1. Resolve entity slugs (disambiguation)
  const fromSlug = await repo.findSimilarSlug(fromCandidate, r.from.name);
  const toSlug = await repo.findSimilarSlug(toCandidate, r.to.name);

  // 2. Ensure entity pages exist
  const c1 = await repo.ensureEntityPage(fromSlug, r.from.type, r.from.name, r.relation, r.context, sourceSlug);
  const c2 = await repo.ensureEntityPage(toSlug, r.to.type, r.to.name, r.relation, r.context, sourceSlug);

  // 3. Link between entities
  await repo.link(fromSlug, toSlug, `[${r.relation}] ${r.context}`);

  // 4. Link from source document to entities
  await repo.link(sourceSlug, fromSlug, `Mentions ${r.from.name}`);
  await repo.link(sourceSlug, toSlug, `Mentions ${r.to.name}`);
}
```

### 瓶颈分析
| 操作 | 数据库调用次数 | 说明 |
|------|----------------|------|
| findSimilarSlug | 1-2 次 (含 search) | 精确匹配失败时调用 search |
| ensureEntityPage | 2 次 (get + put) | 包含一次 getPage 和一次 putPage |
| link | 3 次 | 实体间链接 + 2 个源文档链接 |

**每个关系需要 5-7 次数据库操作**，且全部串行执行。

### 性能影响
- **时间复杂度**: O(n × m)，n = 关系数量，m = 每个关系的 DB 调用次数
- **实际测试**: 假设每个关系处理耗时 100ms，100 个关系需要 10 秒

### 优化建议
1. **批量查询**: 使用 `Promise.all` 并行处理多个关系
2. **批量 upsert**: 批量创建 entity pages 和 links
3. **跳过 syncPageToSearch**: 在 batch import 期间延迟索引更新，最后统一批量刷新

---

## 3. syncPageToSearch 截断策略

### 当前实现
- **文件**: `src/repositories/brain-repo.ts`
- **截断阈值**: `MAX_DOC_LENGTH = 8000`

```typescript
const MAX_DOC_LENGTH = 8000;
const doc = fullDoc.length > MAX_DOC_LENGTH 
  ? fullDoc.slice(0, MAX_DOC_LENGTH) + '\n... (truncated)'
  : fullDoc;
```

### 截断内容
```
${page.title}

${page.compiledTruth}

${page.timeline}
```

### 瓶颈分析
| 问题 | 严重程度 | 描述 |
|------|----------|------|
| 固定 8000 字符截断 | 中 | 部分信息丢失，可能影响语义搜索准确性 |
| 无差别的截断 | 低 | 未考虑不同内容类型的重要性差异 |
| 时间线被截断 | 高 | 时间线通常包含关键事件信息 |

### 优化建议
1. **自适应截断**: 优先保留标题和时间线，只截断 compiledTruth
2. **分块索引**: 将长文档分块索引，而不是简单截断
3. **配置化阈值**: 允许用户根据 embedding 模型调整截断长度

---

## 4. embedAll 全量刷新性能

### 当前实现
- **文件**: `src/repositories/brain-repo.ts`
- **实现方式**: for 循环串行调用 `syncPageToSearch`

```typescript
async embedAll(): Promise<number> {
  const pages = await this.listPages({ limit: 100000 });
  for (const page of pages) {
    await this.syncPageToSearch(page.slug);
  }
  return pages.length;
}
```

### 瓶颈分析
| 问题 | 严重程度 | 描述 |
|------|----------|------|
| 串行处理 | 🔴 严重 | 每个页面单独 upsert，无法利用批量操作 |
| 重复 I/O | 🔴 严重 | 每次 syncPageToSearch 都单独调用 seekdb upsert |
| 未使用批量 API | 🔴 严重 | `syncPagesToSearch` 方法已存在但未使用 |

### 对比：已存在但未使用的批量方法
```typescript
// brain-repo.ts 中已实现的批量方法
async syncPagesToSearch(slugs: string[]): Promise<void> {
  const pages = await Promise.all(slugs.map(s => this.getPage(s)));
  // 批量 upsert...
}
```

### 优化建议
1. **直接使用 syncPagesToSearch**: `embedAll` 应调用批量方法
2. **并发控制**: 使用 `p-limit` 或类似库控制并发数量
3. **增量更新**: 记录上次 embed 时间，只处理变更的页面

---

## 5. 其他潜在性能问题

### 5.1 putPage 内部调用 syncPageToSearch
- 每次创建/更新页面都会立即同步到搜索索引
- **影响**: Batch import 期间产生大量重复 I/O

### 5.2 timelineAddBatch 未使用事务
```typescript
async timelineAddBatch(entries: TimelineEntry[]): Promise<void> {
  for (const entry of entries) {
    await this.db.client.execute(...); // 逐条插入，无事务
  }
}
```
- **影响**: 批量插入时性能差，无原子性保证

### 5.3 entity-link.ts 中的 content 截断
```typescript
// 前 4000 + 后 1000 = 5000 字符
if (trimmed.length <= 5000) {
  context = trimmed;
} else {
  context = trimmed.slice(0, 4000) + "\n\n...\n\n" + trimmed.slice(-1000);
}
```
- **影响**: 可能遗漏文档中间的实体关系

---

## 6. 性能优化优先级总结

| 优先级 | 优化项 | 预期收益 |
|--------|--------|----------|
| 🔴 P0 | embedAll 使用批量方法 | 10x+ 提升 |
| 🔴 P0 | applyEntityLinks 并行化 | 5x+ 提升 |
| 🟠 P1 | putPage 延迟 sync | 减少 50% I/O |
| 🟠 P1 | timelineAddBatch 事务优化 | 批量插入性能 |
| 🟡 P2 | syncPageToSearch 自适应截断 | 搜索质量提升 |
| 🟡 P2 | 动态 batch size | LLM 效率优化 |

---

## 7. 缓存策略建议

### 需要缓存的数据
1. **Entity Slug 映射**: 已解析的 entity → slug 映射
2. **页面存在性**: 已确认存在的 slug 列表
3. **LLM 响应**: 相同内容的 entity extraction 结果

### 缓存实现建议
- 使用内存 Map 存储短期缓存（单次 import 会话）
- 或使用 Redis 存储跨会话缓存

---

*Generated by IronTiger (task-4)*