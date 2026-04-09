# 冗余代码分析报告

**分析日期**: 2026-04-09  
**分析范围**: src/ 目录下所有 TypeScript 文件

---

## 一、严重冗余代码

### 1. 🔴 重复的 LLM 调用实现

**问题**: 三个文件各自实现了几乎相同的 LLM 调用逻辑

| 文件 | 行数 | 实现方式 |
|------|------|----------|
| `src/ai/compiler.ts` | 528 行 | `callLLM()` 函数 |
| `src/ai/timeline-extractor.ts` | 435 行 | `callLLM()` 函数 |
| `src/ai/entity-link.ts` | 226 行 | 内联 `fetch()` 调用 |

**重复代码片段**:

```typescript
// 三个文件都有这段代码
llm.baseURL.endsWith("/") 
  ? llm.baseURL + "chat/completions" 
  : llm.baseURL + "/chat/completions"
```

**重复代码量**: ~150 行 × 3 = ~450 行

**建议**: 提取到 `src/ai/llm-client.ts` 公共模块

```typescript
// 建议创建 src/ai/llm-client.ts
export async function callLLM(
  llm: ResolvedLLM, 
  prompt: string, 
  options: { maxTokens: number; systemPrompt?: string }
): Promise<string>
```

---

### 2. 🔴 重复的 resolveApiKey 函数

**问题**: 三个文件都有完全相同的 `resolveApiKey` 函数

```typescript
// 在 compiler.ts, timeline-extractor.ts, entity-link.ts 都存在
function resolveApiKey(llm: ResolvedLLM): string {
  if (llm.apiKey) return llm.apiKey;
  if (llm.apiKeyEnv) return process.env[llm.apiKeyEnv] ?? "";
  return "";
}
```

**重复代码量**: ~5 行 × 3 = ~15 行

**建议**: 提取到 `src/settings.ts` 或 `src/ai/llm-client.ts`

---

### 3. 🔴 重复的错误处理模式

**问题**: 三个 AI 模块都有相同的错误处理模式

```typescript
// 模式在三个文件中重复出现
try {
  const resp = await fetch(...);
  if (!resp.ok) {
    const text = await resp.text();
    console.warn(`[module] LLM call failed (${resp.status}): ${text.slice(0, 200)}`);
    return ""; // 或 return []
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  console.warn(`[module] LLM call error: ${msg}`);
  return ""; // 或 return []
}
```

**建议**: 统一到公共 LLM 客户端

---

## 二、中等冗余代码

### 4. 🟠 commands/index.ts 中的重复模式

**问题**: 26 次 `await withRepo(program, async (repo) => {...})` 调用

**文件大小**: 1447 行

**重复模式**:
- `withRepo()` 包装器
- `print(program, ...)` 调用 (37 次)
- `isDryRun(opts)` 检查 (9 次)

**建议**: 
1. 抽取命令处理器模式
2. 考虑命令注册 DSL

---

### 5. 🟠 JSON 解析模式

**问题**: 46 处 `JSON.stringify` / `JSON.parse` 调用

**常见模式**:
```typescript
console.log(JSON.stringify(payload, null, 2)); // 8 处
```

**建议**: 创建统一的输出格式化函数

---

### 6. 🟠 日志模式不统一

**问题**: 三个不同的日志前缀格式

| 文件 | 前缀格式 |
|------|----------|
| compiler.ts | `[compiler]` |
| timeline-extractor.ts | `[timeline-extractor]` |
| entity-link.ts | `[ebrain]` |

**建议**: 统一日志模块

---

## 三、轻微冗余代码

### 7. 🟡 导入重复

**问题**: 相同导入在多个文件中重复

| 导入 | 重复次数 |
|------|----------|
| `import { BrainDb } from "../db/client"` | 5 |
| `import type { ResolvedLLM } from "../settings"` | 4 |
| `import { BrainRepository } from "../repositories/brain-repo"` | 4 |

**影响**: 维护成本增加

---

## 四、冗余代码统计

| 类别 | 位置 | 重复行数 | 优先级 |
|------|------|----------|--------|
| LLM 调用逻辑 | 3 个 AI 文件 | ~450 行 | 🔴 P0 |
| resolveApiKey | 3 个 AI 文件 | ~15 行 | 🔴 P0 |
| 错误处理模式 | 3 个 AI 文件 | ~60 行 | 🔴 P0 |
| withRepo 模式 | commands/index.ts | ~200 行 | 🟠 P1 |
| JSON 格式化 | 多个文件 | ~20 行 | 🟡 P2 |

**总计**: 约 ~745 行冗余代码

---

## 五、重构建议

### 立即重构 (P0)

创建 `src/ai/llm-client.ts`:

```typescript
// src/ai/llm-client.ts
export interface LLMCallOptions {
  maxTokens: number;
  systemPrompt?: string;
  temperature?: number;
}

export function resolveApiKey(llm: ResolvedLLM): string {
  if (llm.apiKey) return llm.apiKey;
  if (llm.apiKeyEnv) return process.env[llm.apiKeyEnv] ?? "";
  return "";
}

export async function callLLM(
  llm: ResolvedLLM,
  prompt: string,
  options: LLMCallOptions
): Promise<string> {
  const apiKey = resolveApiKey(llm);
  if (!apiKey) {
    console.warn(`[llm-client] No API key configured`);
    return "";
  }

  const url = llm.baseURL.endsWith("/")
    ? llm.baseURL + "chat/completions"
    : llm.baseURL + "/chat/completions";

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          { role: "system", content: options.systemPrompt ?? "You are a helpful assistant." },
          { role: "user", content: prompt },
        ],
        temperature: options.temperature ?? 0.1,
        max_tokens: options.maxTokens,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`[llm-client] API failed (${resp.status}): ${text.slice(0, 200)}`);
      return "";
    }

    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[llm-client] Error: ${msg}`);
    return "";
  }
}
```

**预期效果**:
- 减少 ~525 行重复代码
- 统一 LLM 调用行为
- 便于添加重试、超时、缓存等功能

---

### 短期重构 (P1)

1. **创建命令处理器抽象**
   - 减少 `withRepo` 重复
   - 统一 `--dry-run` 处理
   - 统一输出格式

2. **统一日志模块**
   - 创建 `src/utils/logger.ts`
   - 支持模块名前缀
   - 支持结构化日志

---

## 六、重构优先级

| 优先级 | 任务 | 预期收益 | 工作量 |
|--------|------|----------|--------|
| P0 | 创建统一 LLM 客户端 | -525 行，+可维护性 | 2-3 小时 |
| P1 | 命令处理器抽象 | -200 行，+可读性 | 4-6 小时 |
| P2 | 统一日志模块 | +可维护性 | 1-2 小时 |
| P2 | JSON 格式化统一 | -20 行 | 30 分钟 |

---

*报告生成时间: 2026-04-09*