# 错误处理与可恢复性审计报告

**审计范围**: ex-brain 核心模块
**审计日期**: 2026-04-09
**审计人**: HappyKnight (task-5)

---

## 一、执行摘要

本次审计对 ex-brain 项目的错误处理机制进行了全面检查，涵盖 LLM API 调用、数据库操作、文件 IO、降级策略和日志系统。审计发现 **5 个关键问题 (Critical)**、**6 个主要问题 (Major)** 和 **4 个次要问题 (Minor)**。

### 关键发现

| 类别 | 状态 | 说明 |
|------|------|------|
| LLM API 调用 | ⚠️ 需改进 | 静默失败，无重试机制 |
| 数据库操作 | ❌ 缺失 | 无错误处理，无事务 |
| MCP Server | ❌ 缺失 | 20+ 工具无错误处理 |
| 降级策略 | ✅ 良好 | hash embed fallback 正常 |
| 日志系统 | ⚠️ 需改进 | 缺少结构化日志 |

---

## 二、详细分析

### 2.1 LLM API 调用失败处理

**涉及文件**: `src/ai/compiler.ts`

#### 问题 1: 静默失败导致状态不明确 (Critical)

```typescript
// compiler.ts: callLLM()
async function callLLM(llm: ResolvedLLM, prompt: string, maxTokens: number): Promise<string> {
  // ...
  try {
    // HTTP 调用
    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`[compiler] LLM call failed (${resp.status}): ${text.slice(0, 200)}`);
      return "";  // ❌ 返回空字符串，不抛出异常
    }
    // ...
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[compiler] LLM call error: ${msg}`);
    return "";  // ❌ 捕获所有异常但返回空
  }
  // ...
}
```

**问题**:
- HTTP 错误 (4xx/5xx) 被降级为返回空字符串
- 网络异常被捕获后静默返回空字符串
- 解析失败 (JSON 格式错误) 返回空字符串
- 调用方无法区分 "API 不可用" vs "返回空结果"

**影响**: 调用方可能将空字符串当作有效响应处理，导致数据丢失或状态不一致。

#### 问题 2: 无重试机制 (Critical)

当遇到临时网络抖动、API 限流 (429) 时，系统直接失败，没有重试逻辑。LLM API 调用是高网络依赖操作，应该有指数退避重试。

#### 问题 3: 错误信息不完整 (Minor)

```typescript
console.warn(`[compiler] LLM call failed (${resp.status}): ${text.slice(0, 200)}`);
```

只打印前 200 字符，可能遗漏关键错误信息。缺少请求 ID、模型名、时间戳等调试信息。

#### 问题 4: 降级后无明确标记 (Major)

```typescript
// compiler.ts: compileTruth()
const apiKey = resolveApiKey(llm);
if (!apiKey) {
  return {
    compiledTruth: appendFact(input.currentTruth, input.newInfo, input.source),
    changed: true,
    changeType: "append",
    changeSummary: "LLM not configured, appended as simple fact",  // ✅ 有说明
    // ...
  };
}
```

虽然有 `changeSummary` 说明，但调用方需要解析这个字符串才能判断是否使用了 LLM。建议增加明确的标志位。

---

### 2.2 降级策略 (Hash Embed Fallback)

**涉及文件**: `src/ai/embed-factory.ts`, `src/ai/hash-embed.ts`

#### 良好实践 ✅

1. **自动降级机制**:
```typescript
// embed-factory.ts
if (!cfg.apiKey) {
  console.warn(
    `[ebrain] embed provider=openai_compatible but no API key; falling back to hash.`,
  );
  return new LocalHashEmbeddingFunction();
}
```

2. **清晰的警告日志**: 用户能明确知道系统降级了

3. **确定性哈希向量**: `hash-embed.ts` 实现了零依赖、确定性的伪向量生成

#### 改进建议 (Minor)

- 降级后可通过设置或 API 暴露当前 embed 模式，便于程序化检查

---

### 2.3 数据库操作异常处理

**涉及文件**: `src/db/client.ts`, `src/repositories/brain-repo.ts`

#### 问题 5: 数据库连接无错误处理 (Critical)

```typescript
// client.ts: BrainDb.connect()
static async connect(dbPath: string, settings?: ResolvedSettings): Promise<BrainDb> {
  const client = settings?.remote
    ? await BrainDb.openRemoteClient(settings.remote)
    : useRemoteSeekdb()
      ? await BrainDb.openRemoteClientFromEnv()
      : await BrainDb.openEmbeddedClient(dbPath);  // ❌ 无 try-catch

  // ...
}
```

**问题**: 数据库连接失败时，错误直接抛出，无重试或优雅降级。

#### 问题 6: 数据库操作无错误处理 (Critical)

```typescript
// brain-repo.ts: 几乎所有方法
async getPage(slug: string): Promise<PageRecord | null> {
  const rows = await this.db.client.execute(
    `SELECT slug, type, title ...`,
    [slug],
  );  // ❌ 无 try-catch
  // ...
}
```

所有 SQL 执行都没有错误处理，数据库错误会导致整个 CLI 命令失败。

#### 问题 7: Batch 操作无事务 (Major)

```typescript
// brain-repo.ts: timelineAddBatch()
async timelineAddBatch(entries: TimelineEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const now = nowIso();
  for (const entry of entries) {
    await this.db.client.execute(
      `INSERT INTO timeline_entries ...`,
      [...],
    );  // ❌ 循环单条插入，中途失败会导致部分数据
  }
}
```

#### 部分正确处理 (值得学习)

```typescript
// brain-repo.ts: findSimilarSlug()
try {
  const hits = await this.search(entityName, 1);
  // ...
} catch {
  // Search may fail during batch import, ignore and return candidate
}
```

虽然用了空的 catch，但至少考虑了批量导入时的容错。

---

### 2.4 文件 IO 错误处理

**涉及文件**: `src/commands/index.ts`, `src/markdown/io.ts`

#### 问题 8: 文件操作错误处理不完整 (Major)

```typescript
// commands/index.ts: import 命令
const content = await readTextFile(file);
// ... 处理 ...
```

- ✅ 有 `fileExists()` 检查文件存在
- ❌ 但没有处理读取权限问题、文件损坏 (非 UTF-8)、大文件等

---

### 2.5 MCP Server 错误处理

**涉及文件**: `src/mcp/server.ts`

#### 问题 9: MCP 工具无错误处理 (Critical)

```typescript
// server.ts: 所有 20+ 工具
server.registerTool(
  "brain_search",
  { /* schema */ },
  async ({ query, type, limit }) => ({
    content: [{ type: "text", text: JSON.stringify(await repo.search(...)) }],
    // ❌ 无 try-catch，任何错误都会导致 MCP 协议错误
  }),
);
```

**问题**:
- 20+ 个工具全部没有错误处理
- 数据库错误会直接崩溃 MCP 连接
- 用户无法获得有意义的错误消息

---

### 2.6 错误日志和调试信息

#### 问题 10: 日志系统不完善 (Major)

| 文件 | 日志方式 | 问题 |
|------|----------|------|
| compiler.ts | `console.warn` | 无结构化信息，缺少请求追踪 |
| embed-factory.ts | `console.warn` | 有模块前缀 `[ebrain]`，较好 |
| brain-repo.ts | 无日志 | 无法追踪数据流 |
| mcp/server.ts | 无日志 | 无法诊断 MCP 调用问题 |

---

## 三、问题汇总与优先级

### 问题清单

| ID | 类别 | 严重度 | 文件 | 问题描述 |
|----|------|--------|------|----------|
| 1 | LLM | Critical | compiler.ts | LLM 调用静默失败，返回空字符串 |
| 2 | LLM | Critical | compiler.ts | 无重试机制 |
| 3 | 数据库 | Critical | client.ts | 数据库连接无错误处理 |
| 4 | 数据库 | Critical | brain-repo.ts | 所有 SQL 操作无错误处理 |
| 5 | MCP | Critical | server.ts | 20+ 工具无错误处理 |
| 6 | 数据库 | Major | brain-repo.ts | batch 操作无事务 |
| 7 | 日志 | Major | 多个文件 | 缺少结构化日志 |
| 8 | LLM | Major | compiler.ts | 降级后无明确状态标记 |
| 9 | 文件 IO | Major | commands/index.ts | 文件操作错误处理不完整 |
| 10 | LLM | Minor | compiler.ts | 错误信息截断 (200字符) |
| 11 | 降级 | Minor | embed-factory.ts | 降级状态无程序化查询接口 |
| 12 | 文件 IO | Minor | markdown/io.ts | readTextFile 无错误处理 |

---

## 四、改进建议

### 4.1 LLM 调用改进 (High Priority)

```typescript
// 建议: 添加错误类型枚举
export enum LLMErrorType {
  API_KEY_MISSING = "API_KEY_MISSING",
  NETWORK_ERROR = "NETWORK_ERROR",
  RATE_LIMIT = "RATE_LIMIT",
  PARSE_ERROR = "PARSE_ERROR",
  SERVER_ERROR = "SERVER_ERROR",
}

// 建议: 添加重试机制
async function callLLMWithRetry(llm: ResolvedLLM, prompt: string, maxTokens: number): Promise<string> {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await callLLM(llm, prompt, maxTokens);
    } catch (error) {
      if (attempt === maxRetries) throw error;
      await sleep(1000 * Math.pow(2, attempt)); // 指数退避
    }
  }
  return "";
}
```

### 4.2 数据库操作改进 (High Priority)

```typescript
// 建议: 添加基础错误处理包装
async function safeExecute(client, sql, params) {
  try {
    return await client.execute(sql, params);
  } catch (error) {
    console.error(`[db] SQL error: ${sql.slice(0, 50)}...`, error.message);
    throw error;
  }
}

// 建议: Batch 操作使用事务
async function timelineAddBatch(entries: TimelineEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const conn = this.db.client.getConnection();
  await conn.beginTransaction();
  try {
    for (const entry of entries) {
      await conn.execute(...);
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  }
}
```

### 4.3 MCP Server 错误处理 (High Priority)

```typescript
// 建议: 全局错误处理包装
server.registerTool("brain_search", { /* schema */ },
  async (params) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await repo.search(...)) }] };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ error: "SEARCH_FAILED", message: error.message })
        }]
      };
    }
  }
);
```

### 4.4 日志增强建议 (Medium Priority)

建议引入结构化日志库 (如 `pino` 或 `winston`)，统一日志格式:

```typescript
// 建议: 统一日志格式
console.log(JSON.stringify({
  timestamp: new Date().toISOString(),
  level: "warn",
  module: "compiler",
  message: "LLM call failed",
  error: { code: "HTTP_429", details: "Rate limited" },
  context: { model: "gpt-4", attempt: 1 }
}));
```

### 4.5 降级状态可观测性 (Low Priority)

```typescript
// embed-factory.ts
export function getCurrentEmbedMode(): "hash" | "openai_compatible" {
  // 返回当前使用的 embed 模式
}
```

---

## 五、测试建议

1. **模拟 LLM API 失败**: 测试网络超时、返回 500 错误、JSON 解析失败场景
2. **数据库故障注入**: 模拟连接断开、SQL 语法错误、死锁
3. **文件 IO 错误**: 模拟文件不存在、权限拒绝、大文件
4. **批量操作原子性**: 验证部分失败时的回滚行为

---

## 六、结论

ex-brain 项目在降级策略方面有良好实践 (hash embed fallback)，但错误处理存在系统性缺失:

- **Critical**: LLM 调用静默失败、数据库操作无保护、MCP 工具无错误处理
- **Major**: Batch 操作无事务、日志不完善、降级状态不可观测
- **Minor**: 错误信息截断、文件操作边界情况

**建议优先级**: 
1. LLM 调用错误处理 + 重试机制
2. MCP Server 工具错误处理
3. 数据库操作基础错误处理
4. 日志系统改进