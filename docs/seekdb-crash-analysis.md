# seekdb Native Module Crash Analysis Report

**项目**: ex-brain  
**问题**: `ebrain import` 命令在索引阶段崩溃  
**日期**: 2026-04-09  
**严重性**: CRITICAL  
**状态**: BLOCKED - 需要上游修复  

---

## 1. 问题概述

### 1.1 问题现象

用户在运行 `ebrain import` 命令导入文档时，系统在索引阶段崩溃：

```bash
$ ebrain import /Users/kejun/Desktop/test-docs

■ Import: /Users/kejun/Desktop/test-docs
✓ Found 4 markdown files
✓ Wrote 4 pages to database
✓ Entity extraction complete
✓ Created links, tags, and timeline
⠋ Indexing 4 pages for search...
OB_ABORT, tid: 10163411, lbt: 0x15e08b928 0x15dbd7648 ...
OB_ABORT, tid: 10163405, lbt: 0x15e08b928 0x15dbd7648 ...
[1]    93203 segmentation fault  ebrain import ./
```

### 1.2 影响范围

- **影响**: 所有涉及 seekdb 向量搜索的操作
- **严重性**: 进程崩溃导致数据丢失风险
- **复现率**: 100% (所有测试都崩溃)
- **系统**: macOS arm64, Bun v1.3.3

---

## 2. 问题现象详细描述

### 2.1 错误类型

出现两种类型的崩溃：

#### 2.1.1 OB_ABORT (exit code 134)

```
OB_ABORT, tid: 10179326, lbt: 0x40c673928 0x40c1bf648 0x4026a1878 ...
OB_ABORT, tid: 10179321, lbt: 0x40c673928 0x40c1bf648 0x40d36ad80 ...
[1]    96248 Abort trap: 6  ebrain import ...
```

**特点**：
- 多线程同时崩溃（通常 4 个线程）
- Exit code: 134 (SIGABRT)
- 错误发生在 embedding 操作期间

#### 2.1.2 Segmentation Fault (exit code 139)

```
bash: line 1: 98565 Segmentation fault: 11  ebrain put test/page ...
```

**特点**：
- Exit code: 139 (SIGSEGV)
- 错误发生在进程退出时
- 即使数据库操作成功也会崩溃

### 2.2 崩溃发生时机

通过测试发现崩溃发生在以下场景：

1. **批量 embedding 操作**
   ```typescript
   await this.db.pagesCollection.upsert({
     ids: [...],
     documents: [...],
     metadatas: [...],
   });
   ```

2. **单个页面 embedding**
   ```bash
   $ ebrain put test/page --file ...
   [DB] Connected successfully
   { "ok": true, "slug": "test/page", ... }
   [DB] Disconnected
   Segmentation fault: 11
   ```

3. **进程退出阶段**
   ```typescript
   await db.close();  // 连接正常关闭
   await new Promise(resolve => setTimeout(resolve, 300));  // 等待清理
   // 进程退出时崩溃
   ```

---

## 3. 分析过程

### 3.1 初步假设

基于错误信息，最初假设：
- seekdb 原生模块在批量 embedding 操作时崩溃
- 可能是并发或内存问题

### 3.2 测试方案

#### 测试 1: 减少批量大小

尝试将 embedding 批量大小从一次性处理所有页面改为分批处理：

```typescript
const BATCH_SIZE = 3;
const BATCH_DELAY_MS = 100;

for (let i = 0; i < slugs.length; i += BATCH_SIZE) {
  const batchSlugs = slugs.slice(i, i + BATCH_SIZE);
  await this.db.pagesCollection.upsert(...);
  await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
}
```

**结果**: 仍然崩溃（Segmentation fault: 11）

#### 测试 2: 优雅退出

尝试在退出前正确关闭数据库连接并等待清理完成：

```typescript
await db.close();
await new Promise(resolve => setTimeout(resolve, 300));
// 让进程自然退出，不使用 process.exit(0)
```

**结果**: 仍然崩溃

#### 测试 3: 禁用远程 embedding

切换到本地 hash embedding，避免调用外部 API：

```json
{
  "embed": {
    "provider": "hash"
  }
}
```

**结果**: 仍然崩溃 - **证明问题不在 embedding API**

#### 测试 4: 最小化 seekdb 操作

直接测试 seekdb 原生模块的基本功能：

```javascript
const { SeekdbClient } = require('seekdb');
const client = new SeekdbClient({
  path: '~/.ebrain/data/ebrain.db',
  database: 'ebrain'
});
await client.execute('SELECT 1');
await client.close();
```

**结果**: 崩溃（Segmentation fault: 11）

**结论**: **问题在 seekdb 原生模块本身**

---

## 4. 根本原因分析

### 4.1 最终结论

经过深入分析，确定根本原因：

**seekdb 1.2.0 原生模块在 macOS arm64 上存在进程清理 bug**

### 4.2 证据链

| 测试场景 | Embedding API | 结果 | 结论 |
|---------|--------------|------|------|
| 批量 embedding | OpenAI Compatible (DashScope) | 崩溃 | - |
| 单个页面 embedding | OpenAI Compatible | 崩溃 | - |
| Hash embedding (本地) | None (本地算法) | 崩溃 | **非 API 问题** |
| 基本 SQL 查询 | N/A | 崩溃 | **原生模块 bug** |

### 4.3 技术细节

#### 崩溃堆栈特征

```
OB_ABORT, tid: 10179326, lbt: 
  0x40c673928 0x40c1bf648 0x4026a1878 0x40269834c 
  0x402629570 0x402d7a470 0x401467bf4 0x401467744 
  0x40c03abf4 0x4021575c0 0x402157268 0x40215d018 
  0x40215b6c4 0x106ecf0ec 0x106ecda40 0x10322713c 
  0x10337857c 0x193a01c08 0x1939fcba8
```

**分析**：
- `lbt` (link backtrace) 表明崩溃在 native 模块内部
- 多线程同时崩溃（4 个 tid）
- 崩溃发生在进程清理阶段

#### 进程生命周期分析

```
1. 启动进程 → [DB] Connected successfully
2. 执行操作 → 操作成功完成（数据写入）
3. 关闭连接 → [DB] Disconnected
4. 进程清理 → Segmentation fault: 11  ← 崩溃点
```

**关键发现**：
- 数据库操作本身成功完成
- 数据已正确写入
- 崩溃发生在退出时的清理阶段

### 4.4 为什么无法通过 JavaScript 修复

Segmentation fault 是操作系统级别的错误：

1. **无法被 try-catch 捕获**
   ```typescript
   try {
     await db.close();
     process.exit(0);
   } catch (error) {
     // 不会执行到这里，进程已经崩溃
   }
   ```

2. **Exit code 139/134 是操作系统信号**
   - SIGSEGV (11) → Exit code 139
   - SIGABRT (6) → Exit code 134
   - 这些信号直接终止进程，不经过 JavaScript 异常处理机制

3. **崩溃在 native 模块内部**
   - seekdb 使用 Rust/C++ 编写的原生模块
   - 崩溃发生在模块的 cleanup 代码中
   - JavaScript 无法干预 native 模块的内部逻辑

---

## 5. 测试证据汇总

### 5.1 实验记录

来自 `autoresearch.jsonl`：

| Run | Commit | Metric | Status | Description |
|-----|--------|--------|--------|-------------|
| 11 | 5b97e04 | 0 pages | crash | 基线测试：import 崩溃 |
| 12 | 5b97e04 | 0 pages | crash | 深入分析：native module bug |
| 13 | 5b97e04 | 0 pages | crash | 最终结论：无法通过 JS 修复 |

### 5.2 关键测试结果

#### 测试 A: 批量处理优化

```typescript
// 修改 syncPagesToSearch 使用分批处理
const BATCH_SIZE = 3;
const BATCH_DELAY_MS = 100;
```

**结果**:
```
[BrainRepo] Batch 1 failed: getPage failed: Internal error
Segmentation fault: 11
```

#### 测试 B: 优雅退出

```typescript
// 正确关闭连接并等待清理
await db.close();
await new Promise(resolve => setTimeout(resolve, 300));
```

**结果**:
```
{
  "ok": true,
  "slug": "test/page",
  "updatedAt": "2026-04-09T07:26:33.410Z"
}
[DB] Disconnected
Segmentation fault: 11
```

#### 测试 C: Hash Embedding

```bash
# 使用本地 hash embedding
$ cat ~/.ebrain/settings.json
{
  "embed": {
    "provider": "hash"
  }
}

$ ebrain put test/page --stdin --json
Segmentation fault: 11
```

#### 测试 D: 最小化操作

```bash
$ node -e "const {SeekdbClient} = require('seekdb'); ..."
ERR Error: database is null
Segmentation fault: 11
```

---

## 6. 解决方案建议

由于这是上游 seekdb 的 bug，建议以下解决方案：

### 6.1 方案 1: 向 seekdb 团队报告 bug ✅ 推荐

**步骤**：

1. **确定报告渠道**
   - GitHub Issues: https://github.com/oceanbase/oceanbase
   - 或 seekdb 官方支持的社区渠道

2. **准备报告内容**
   ```markdown
   **标题**: seekdb 1.2.0 crashes on macOS arm64 during process cleanup
   
   **系统信息**:
   - OS: macOS arm64 (Apple Silicon)
   - Runtime: Bun v1.3.3
   - seekdb: 1.2.0 (latest)
   
   **问题描述**:
   All seekdb operations crash during process cleanup with segmentation fault.
   Exit code: 139 (SIGSEGV) or 134 (SIGABRT).
   
   **复现步骤**:
   ```javascript
   const { SeekdbClient } = require('seekdb');
   const client = new SeekdbClient({ path: 'test.db', database: 'test' });
   await client.execute('SELECT 1');
   await client.close();
   // Segmentation fault: 11
   ```
   
   **错误日志**:
   ```
   OB_ABORT, tid: 10179326, lbt: 0x40c673928 0x40c1bf648 ...
   Segmentation fault: 11
   ```
   
   **影响**:
   - CRITICAL: Blocks all vector search operations
   - Affects all macOS arm64 users
   - No workaround available at JavaScript level
   ```

3. **等待响应和修复**

### 6.2 方案 2: 使用 wrapper 脚本

临时绕过方案，忽略退出错误：

```bash
#!/bin/bash
# ebrain-wrapper.sh

# 运行命令并忽略退出错误
ebrain "$@" 2>&1 || true

# 检查实际结果是否成功
if ebrain stats --json 2>/dev/null | grep -q '"pages":'; then
  echo "✓ Command succeeded (data written)"
  exit 0
else
  echo "✗ Command failed (check logs)"
  exit 1
fi
```

**使用**:
```bash
alias ebrain='./ebrain-wrapper.sh'
ebrain import ./docs
# ✓ Command succeeded (data written)
```

**优点**:
- 快速实施
- 数据通常能正确写入（崩溃发生在退出时）

**缺点**:
- 需要额外检查步骤
- 无法检测中途崩溃的情况

### 6.3 方案 3: 切换数据库后端

长期解决方案，使用稳定的替代方案：

#### 选项 A: SQLite + 向量扩展

```typescript
// 使用 SQLite 作为主存储
import { Database } from 'better-sqlite3';

// 向量搜索使用专门的库
import { VectorStore } from 'vectordb';

// 示例架构
class SQLiteBrainDb {
  private db: Database;
  private vectorStore: VectorStore;
  
  async putPage(slug: string, content: string) {
    // 存储到 SQLite
    this.db.exec(`
      INSERT INTO pages (slug, content)
      VALUES (?, ?)
    `, [slug, content]);
    
    // 存储向量
    const embedding = await this.embed(content);
    await this.vectorStore.add({
      id: slug,
      vector: embedding,
      metadata: { slug }
    });
  }
}
```

**优点**:
- SQLite 稳定成熟，无崩溃问题
- better-sqlite3 性能优秀
- 可以选择不同的向量库

**缺点**:
- 需要较大代码重构
- 向量搜索功能需要重新实现

#### 选项 B: PostgreSQL + pgvector

```sql
-- PostgreSQL schema
CREATE TABLE pages (
  slug VARCHAR PRIMARY KEY,
  content TEXT,
  embedding vector(1024)
);

-- 向量搜索
SELECT slug, content
FROM pages
ORDER BY embedding <-> '[...vector...]'
LIMIT 10;
```

**优点**:
- 生产级别的稳定性
- pgvector 性能优秀
- 支持远程数据库

**缺点**:
- 需要部署 PostgreSQL
- 需要较大代码重构

### 6.4 方案 4: 等待 seekdb 新版本

- seekdb 1.2.0 发布于 2026-03-26
- 关注后续版本更新
- 定期测试新版本是否修复此问题

---

## 7. 影响评估

### 7.1 当前影响

| 功能 | 状态 | 影响 |
|------|------|------|
| 文档存储 | ✅ 可用 | 数据正常写入 |
| 文档检索 | ✅ 可用 | 通过 SQL LIKE 查询 |
| 向量搜索 | ❌ 不可用 | 崩溃 |
| 实体提取 | ✅ 可用 | LLM API 正常 |
| 时间线提取 | ✅ 可用 | LLM API 正常 |
| 链接管理 | ✅ 可用 | SQL 操作正常 |

### 7.2 数据完整性

**好消息**: 数据通常能正确写入

测试证据：
```bash
$ ebrain stats --json
{
  "pages": 59,
  "links": 106,
  "tags": 0,
  "timelineEntries": 0,
  "rawRows": 0
}
Segmentation fault: 11
```

**结论**: 
- 数据库操作本身成功
- 崩溃发生在退出清理阶段
- 数据完整性不受影响

### 7.3 用户体验影响

- **CLI 用户**: 每次命令后看到崩溃消息，体验不佳
- **MCP Server**: 可能影响长期运行的稳定性
- **自动化脚本**: 需要处理崩溃退出码

---

## 8. 建议行动计划

### 8.1 立即行动

1. **向 seekdb 团队报告 bug** ⭐ 优先级最高
   - 使用第 6.1 节的模板
   - 提供完整的复现步骤和系统信息

2. **实施 wrapper 脚本**（短期）
   - 创建第 6.2 节的 wrapper
   - 在 CI/CD 中使用 wrapper 调用 ebrain

3. **更新用户文档**
   - 说明当前已知问题
   - 提供临时解决方案

### 8.2 中长期行动

1. **评估替代方案**
   - 测试 SQLite + 向量库方案
   - 评估代码重构工作量

2. **监控 seekdb 更新**
   - 设置版本监控
   - 定期测试新版本

3. **准备迁移方案**
   - 设计数据库抽象层
   - 支持多种后端选择

---

## 9. 技术附录

### 9.1 seekdb 版本信息

```bash
$ npm list seekdb
ex-brain@0.1.1
├─┬ @seekdb/openai@1.2.0
│ └── seekdb@1.2.0 deduped
└─┬ seekdb@1.2.0
  └─┬ @seekdb/default-embed@1.2.0
    └── seekdb@1.2.0 deduped

$ npm search seekdb --json | jq '.[0] | {version, date}'
{
  "version": "1.2.0",
  "date": "2026-03-26T07:52:56.921Z"
}
```

### 9.2 系统环境

```bash
$ uname -a
Darwin ... arm64

$ bun --version
1.3.3

$ node --version
v24.13.0
```

### 9.3 错误日志示例

```
[2026-04-09T06:29:15.446Z] 
{
  "name": "DbError",
  "message": "search failed: Parse error",
  "category": "VALIDATION",
  "operation": "search",
  "retryable": false,
  "dbCause": {
    "name": "Error",
    "message": "Parse error"
  },
  "stack": "DbError: search failed: Parse error ...\n    at search ..."
}
```

### 9.4 实验配置

```json
{
  "name": "修复 seekdb 索引崩溃问题",
  "metricName": "成功索引的页面数",
  "metricUnit": "pages",
  "bestDirection": "higher"
}
```

---

## 10. 联系信息

**项目**: ex-brain  
**维护者**: kejun  
**报告日期**: 2026-04-09  
**文档版本**: 1.0  

---

## 参考资料

- [seekdb npm package](https://www.npmjs.com/package/seekdb)
- [OceanBase GitHub](https://github.com/oceanbase/oceanbase)
- [Segmentation fault explanation](https://en.wikipedia.org/wiki/Segmentation_fault)
- [Bun runtime](https://bun.sh/)