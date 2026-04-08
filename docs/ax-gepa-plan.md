# Ax + GEPA 优化方案

> **目标**：将 ex-brain 的 AI 模块从"手写 prompt + 手动重试"升级为"Signature 声明式 + GEPA 自动优化 + 结构化验证"

---

## 一、现状诊断

### 当前架构

```
CLI / MCP Server
  └─ BrainRepository
       ├─ compilePage()    → compileTruth()      → callLLM() [手写 prompt]
       ├─ ingestContent()  → extractTimelineEvents() → callLLM() [手写 prompt]
       └─ (entity link)    → extractRelations()      → callLLM() [手写 prompt]

llm-client.ts (~200 行)
  └─ callLLM()  fetch + 指数退避重试 + 错误分类 + 超时
```

### 核心问题

| 问题 | 影响 |
|------|------|
| **Prompt 硬编码在字符串中** | 无法版本化、无法对比、无法自动优化 |
| **手动 JSON 解析 + jsonrepair 兜底** | LLM 输出格式错误时无重试，直接静默失败 |
| **手写 200 行 LLM 基础设施** | retry、timeout、error classification 都要自己维护 |
| **无类型安全** | `as Record<string, unknown>` 满天飞，字段错误运行时才发现 |
| **无法自动优化** | prompt 质量完全依赖人工调优 |

---

## 二、改造策略：渐进式替换

**原则**：不破坏现有 API，不改变用户命令，逐个模块替换。

### 总体架构变化

```
改造前:                         改造后:
┌──────────────┐                ┌──────────────┐
│  CLI / MCP   │                │  CLI / MCP   │  ← 不变
└──────┬───────┘                └──────┬───────┘
       │                               │
┌──────▼───────┐                ┌──────▼───────┐
│BrainRepository│                │BrainRepository│  ← 接口不变
└──────┬───────┘                └──────┬───────┘
       │                               │
┌──────▼─────────────────┐   ┌────────▼──────────────────┐
│ ai/                    │   │ ai/                       │
│  compiler.ts (手写)    │   │  compiler-ax.ts (Ax)      │  ← Phase 2
│  entity-link.ts (手写) │   │  entity-link-ax.ts (Ax)   │  ← Phase 2
│  timeline-extractor.ts │   │  timeline-ax.ts (Ax)      │  ← Phase 2
│  llm-client.ts (200行) │   │  llm-client.ts → 删除     │  ← Phase 1
└────────────────────────┘   │  settings.ts → 适配层     │  ← Phase 1
                             └───────────────────────────┘
                                       │
                             ┌─────────▼──────────┐
                             │  @ax-llm/ax (npm)  │
                             │  - Signature       │
                             │  - AxGen           │
                             │  - 15+ LLM 供应商  │
                             │  - AxGEPA          │
                             └────────────────────┘
```

---

## 三、Phase 详细计划

### ✅ Phase 1：基础设施替换（llm-client → Ax AI 层）—— 已完成

**状态**: ✅ DONE — 2025-04-13

**改动清单**:
| 文件 | 状态 | 说明 |
|------|------|------|
| `src/ai/ax-adapter.ts` | ✅ 新建 | ResolvedLLM → Ax AI 实例工厂 |
| `src/ai/compiler-ax.ts` | ✅ 新建 | Ax Signature 版编译器 |
| `src/ai/entity-link-ax.ts` | ✅ 新建 | Ax Signature 版实体提取 |
| `src/ai/timeline-ax.ts` | ✅ 新建 | Ax Signature 版时间线提取 |
| `src/ai/ax-adapter.test.ts` | ✅ 新建 | 适配层测试 (8 tests) |
| `src/ai/compiler-ax.test.ts` | ✅ 新建 | 编译器测试 (5 tests) |
| `src/ai/timeline-ax.test.ts` | ✅ 新建 | 时间线测试 (6 tests) |
| `package.json` | ✅ 修改 | + `@ax-llm/ax@^19.0.43` |
| `src/repositories/brain-repo.ts` | ✅ 修改 | 导入指向 -ax 模块 |
| `src/commands/index.ts` | ✅ 修改 | entity-link 指向 -ax 模块 |

**测试结果**: 81 pass / 0 fail
**构建**: 成功 (4.62 MB, 578 modules)
**CLI**: 正常工作

### Phase 2：Prompt → Signature 改造

**目标**：用 Ax 的 AI 抽象替换手写的 `llm-client.ts`

**改动范围**：
| 文件 | 动作 | 行数变化 |
|------|------|----------|
| `src/ai/llm-client.ts` | **删除** | -200 行 |
| `src/ai/ax-adapter.ts` | **新建** | +60 行 |
| `package.json` | `npm install @ax-llm/ax` | +1 依赖 |
| `src/settings.ts` | 微调，兼容 Ax | ±5 行 |

**核心设计 — `ax-adapter.ts`**：

```typescript
// 将 ex-brain 的 ResolvedLLM 映射到 Ax 的 ai() 调用
import { ai, type AxAIInterface } from "@ax-llm/ax";
import type { ResolvedLLM } from "../settings";

export function createAxAI(llm: ResolvedLLM): AxAIInterface {
  const apiKey = llm.apiKey || (llm.apiKeyEnv ? process.env[llm.apiKeyEnv] : "");
  
  // ex-brain 用通义千问（OpenAI-compatible），直接映射
  return ai({
    name: "openai",
    apiKey,
    ...(llm.baseURL ? { endpoint: llm.baseURL } : {}),
  });
}
```

**Ax 自带能力直接替换 llm-client.ts 的功能**：

| llm-client.ts 功能 | Ax 替代方案 |
|---|---|
| 指数退避重试 | `ax()` 内置 `maxRetries` |
| 超时控制 | `ax()` 内置 `timeout` |
| 错误分类 (APIError/TimeoutError/RateLimitError) | Ax 内置错误类型 |
| API Key 解析 | 在 adapter 中统一处理 |
| `/chat/completions` URL 拼接 | Ax 15+ 供应商自动处理 |

**验收标准**：
- [ ] `bun test` 全部通过（现有测试不受影响）
- [ ] `ebrain compile` 命令行为不变
- [ ] `llm-client.ts` 可安全删除

**风险**：极低 — Ax 的 `ai()` API 与现有 `fetch` 调用等效，只是换了封装层。

---

### Phase 2：Prompt → Signature 改造

**目标**：将三个 AI 模块从手写 prompt 改为 Ax Signature 模式

#### 2A. compiler.ts → compiler-ax.ts

**当前**：3 个手写 prompt（分析 → 合并 → 时间线），每步手动调 LLM + 手动解析

**改造后**：
```typescript
import { ax, f, type AxGen } from "@ax-llm/ax";
import type { AxAIInterface } from "@ax-llm/ax";

// Signature 声明输入输出（替代手写 prompt）
const compileSig = f()
  .input("currentTruth", f.string("Current compiled truth"))
  .input("newInfo", f.string("New information to compile"))
  .input("source", f.string("Information source"))
  .input("date", f.string("Date of information"))
  .input("context", f.string("Page type and title for context"))
  .input("timeline", f.string("Recent timeline events for context"))
  .output("reasoning!", f.string("Step-by-step analysis"))  // Chain of Thought
  .output("changeType", f.class(["append", "update", "replace", "none", "conflict"]))
  .output("compiledTruth", f.string("Updated compiled truth in markdown"))
  .output("changeSummary", f.string("Human-readable summary of changes"))
  .output("confidence", f.number("0 to 1").min(0).max(1))
  .build();

const compiler = ax(compileSig);

// 添加自动重试断言（替代手动 jsonrepair 兜底）
compiler.addAssert(({ compiledTruth }) =>
  compiledTruth.length > 0,
  "Compiled truth must not be empty"
);
compiler.addAssert(({ changeSummary }) =>
  changeSummary.length > 0,
  "Change summary must be provided"
);

// 自动提取 timeline（子签名）
const timelineSig = f()
  .input("newInfo", f.string("Information to extract events from"))
  .input("source", f.string("Source"))
  .input("date", f.string("Date"))
  .output("events", f.object({
    date: f.string("YYYY-MM-DD"),
    summary: f.string().max(120),
    detail: f.string().optional(),
  }).array().max(5))
  .build();

const timelineExtractor = ax(timelineSig);
```

**收益对比**：

| 维度 | 当前 | Ax 改造后 |
|------|------|-----------|
| 代码量 | ~350 行 | ~80 行 |
| Prompt 维护 | 3 个长字符串 | Signature 声明 |
| 失败重试 | 无（jsonrepair 兜底） | **自动重试 + 错误反馈** |
| 类型安全 | `as Record<string, unknown>` | **编译时类型推导** |
| Chain of Thought | 无 | `reasoning!` 内部字段 |
| 可优化性 | ❌ | ✅ 可接 GEPA |

#### 2B. entity-link.ts → entity-link-ax.ts

```typescript
const entitySig = f()
  .input("content", f.string("Text to extract entities from").max(5000))
  .output("relations", f.object({
    fromName: f.string().min(1).max(100),
    fromType: f.class(["person", "company", "project", "organization", "event", "other"]),
    toName: f.string().min(1).max(100),
    toType: f.class(["person", "company", "project", "organization", "event", "other"]),
    relation: f.class([
      "founder_of", "works_at", "leader_of",
      "collaborates_with", "competes_with", "acquired",
      "part_of", "invested_in", "mentioned_in", "related_to"
    ]),
    context: f.string().min(10),
    confidence: f.number().min(0).max(1),
  }).array().max(20))
  .build();

const entityExtractor = ax(entitySig);

// 自动过滤低置信度关系
entityExtractor.addAssert(({ relations }) =>
  relations.every(r => r.confidence >= 0.7),
  "All relations must have confidence >= 0.7"
);
```

#### 2C. timeline-extractor.ts → timeline-ax.ts

```typescript
const timelineSig = f()
  .input("content", f.string("Content to extract events from").max(4000))
  .input("source", f.string("Source identifier"))
  .input("defaultDate", f.string("YYYY-MM-DD fallback date"))
  .output("reasoning!", f.string("Analyze content for events"))
  .output("events", f.object({
    date: f.string("YYYY-MM-DD"),
    summary: f.string().max(120),
    detail: f.string().optional(),
    eventType: f.class(["milestone", "update", "meeting", "announcement", "transaction", "other"]),
    importance: f.number().min(1).max(5),
  }).array().max(5))
  .build();

const timelineExtractor = ax(timelineSig);
```

**验收标准**：
- [ ] 三个模块输出格式与现有完全一致（BrainRepository 调用方零感知）
- [ ] 自动化测试覆盖正常路径 + 边界情况
- [ ] 手写 prompt 的 `compiler.ts`/`entity-link.ts`/`timeline-extractor.ts` 可标记 deprecated

**风险**：低 — Signature 的输入输出类型与现有接口一一对应，行为等价替换。

---

### Phase 3：GEPA 优化基础设施

**目标**：建立训练数据采集 + 评估函数 + GEPA 优化管线

#### 3A. 训练数据采集

**设计**：在 `BrainRepository.compilePage()` 中埋点，自动记录 labeled examples

```typescript
// src/ai/training-collector.ts
interface CompileExample {
  input: {
    currentTruth: string;
    newInfo: string;
    source: string;
    date: string;
    context: string;
    timeline: string;
  };
  expectedOutput: {
    changeType: string;
    compiledTruth: string;
    changeSummary: string;
    confidence: number;
  };
}

// 当用户手动修正 compile 结果时，记录为 training example
// 存储到 ~/.ebrain/training/compile-examples.jsonl
```

**数据来源**：
1. **隐式采集**：用户 `ebrain compile` 后手动编辑 compiled truth → 差异记录为 (input, corrected_output) 对
2. **显式采集**：提供 `ebrain training export` 命令导出已有数据
3. **手动标注**：从知识库中挑选 30 个典型页面，人工标注期望输出

#### 3B. 评估函数（Metric Function）

```typescript
// src/ai/metrics.ts
import type { AxGen } from "@ax-llm/ax";

// 编译器评估：多维度打分
function compileMetric(result: {
  prediction: any;
  example: any;
}): number {
  const { prediction: pred, example: ex } = result;
  let score = 0;
  let weights = 0;

  // 1. changeType 正确性（最重要）
  if (pred.changeType === ex.expectedOutput.changeType) {
    score += 0.4;
  }
  weights += 0.4;

  // 2. compiledTruth 包含关键事实
  const expectedFacts = extractFacts(ex.expectedOutput.compiledTruth);
  const actualFacts = extractFacts(pred.compiledTruth);
  const factRecall = expectedFacts.filter(f => 
    actualFacts.some(af => similarity(f, af) > 0.8)
  ).length / expectedFacts.length;
  score += 0.4 * factRecall;
  weights += 0.4;

  // 3. 无幻觉（不编造未提及的信息）
  const hallucinationPenalty = detectHallucination(pred.compiledTruth, ex.input.newInfo);
  score += 0.2 * (1 - hallucinationPenalty);
  weights += 0.2;

  return weights > 0 ? score / weights : 0;
}

// 实体链接评估：precision / recall
function entityMetric(result: { prediction: any; example: any }): number {
  const predRelations = result.prediction.relations;
  const expectedRelations = result.example.expectedOutput.relations;
  
  // 宽松匹配：关系类型相同 + 实体名相似即算正确
  const correct = predRelations.filter(pr =>
    expectedRelations.some(er =>
      er.relation === pr.relation &&
      similarity(er.fromName, pr.fromName) > 0.8 &&
      similarity(er.toName, pr.toName) > 0.8
    )
  ).length;
  
  const precision = correct / Math.max(predRelations.length, 1);
  const recall = correct / Math.max(expectedRelations.length, 1);
  
  return 2 * precision * recall / (precision + recall + 0.001); // F1
}
```

#### 3C. GEPA 优化命令

```typescript
// src/commands/optimize-cmd.ts
export function registerOptimizeCommands(program: Command): void {
  program
    .command("optimize")
    .argument("<module>", "Module to optimize: compile|entity|timeline")
    .option("--budget <n>", "Max GEPA trials", "30")
    .option("--auto <level>", "Optimization level: light|medium|heavy", "light")
    .option("--reflection-model <model>", "Model for GEPA reflection", "qwen-plus")
    .description("Optimize AI module prompts using GEPA")
    .action(async (module: string, opts: any) => {
      // 1. Load training examples
      const examples = loadTrainingExamples(module);
      
      // 2. Select program and metric
      const program = getAxProgram(module);
      const metricFn = getMetricFn(module);
      
      // 3. Run GEPA
      const optimizer = new AxGEPA({
        numTrials: parseInt(opts.budget),
        reflectionModel: opts.reflectionModel,
      });
      
      const result = await optimizer.compile(
        program,
        examples,
        metricFn,
        { auto: opts.auto }
      );
      
      // 4. Save optimized prompt
      saveOptimizedPrompt(module, result);
      console.log(`Optimized prompt saved. Best score: ${result.bestScore}`);
    });
}
```

**验收标准**：
- [ ] `ebrain optimize compile --auto light` 可在 3-5 分钟内完成
- [ ] 优化后的 prompt 在 holdout 集上评分提升 > 10%
- [ ] 优化结果可一键回滚

**风险**：中 — 需要先积累足够质量的训练数据，否则优化效果有限。

---

### Phase 4：反馈闭环（自我进化）

**目标**：让系统"越用越聪明"

#### 4A. 用户反馈采集

```
用户操作                          系统行为
─────────                        ────────
ebrain compile → 结果不滿意      用户手动编辑 compiled truth
                                 ↓
                                 系统检测差异 → 记录为 (prompt_output, user_correction)
                                 ↓
                                 累积到 training dataset
                                 ↓
                                 定期 cron / 手动触发 GEPA 优化
                                 ↓
                                 更新 prompt → 下次 compile 更准确
```

#### 4B. 定期自动优化

```typescript
// 后台定时（或通过 ebrain optimize --auto 手动触发）
// 当 training examples 积累到 N 个时：
// 1. 用 GEPA 重新优化 prompt
// 2. 对比新 prompt vs 旧 prompt 在 holdout 集上的表现
// 3. 如果提升 > 阈值，自动替换；否则丢弃
```

**验收标准**：
- [ ] 用户修正操作被自动记录
- [ ] 积累到 30+ 样本后可触发优化
- [ ] 优化结果经 holdout 验证后才应用

---

## 四、实施路线图

```
Week 1          Week 2           Week 3           Week 4+
──────────      ──────────       ──────────       ──────────
Phase 1         Phase 2A         Phase 2B         Phase 3
基础设施        Compiler Sig     Entity Sig       GEPA 管线
                + Timeline Sig

├─ npm install  ├─ compiler-ax   ├─ entity-link-  ├─ 训练数据采集
├─ ax-adapter   ├─ timeline-ax   │  ax.ts         ├─ 评估函数
├─ 删 llm-      ├─ 测试覆盖      ├─ 测试覆盖      ├─ optimize 命令
│  client.ts   │                │                │
└─ 验证原有     └─ 验证 API      └─ 验证 API      └─ 手动优化测试
   测试通过        等价性           等价性

                                           Week 5+
                                           ──────────
                                           Phase 4
                                           反馈闭环

                                           ├─ 修正采集
                                           ├─ 自动优化
                                           └─ 版本管理
```

---

## 五、风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| Ax API 不兼容 ex-brain 的 LLM 配置 | 低 | 高 | Phase 1 先验证，不兼容则保留 llm-client.ts 作 fallback |
| Signature 生成的 prompt 质量不如手写 | 中 | 中 | Phase 2 后做 A/B 测试，用 `ebrain optimize` 追赶 |
| 训练数据不足导致 GEPA 效果差 | 高 | 中 | 手动标注 30 个 golden examples 作为种子 |
| GEPA 优化消耗大量 LLM token | 中 | 低 | 用 `auto: light` 控制预算，小模型做 task，大模型仅做 reflection |
| Ax 库版本升级导致 API 变动 | 低 | 中 | 锁定版本号，Phase 1 加集成测试 |

---

## 六、预期收益汇总

| 维度 | 当前 | 改造后 |
|------|------|--------|
| **AI 模块代码量** | ~600 行 | ~200 行（-67%） |
| **基础设施代码** | ~200 行 llm-client | **0 行**（Ax 内置） |
| **LLM 供应商切换** | 改 URL 格式 | 一行改 `name` |
| **类型安全** | 手动 `as` 转换 | 编译时推导 |
| **失败重试** | 无 | 自动 + 带错误反馈 |
| **Prompt 优化** | 手动调 | GEPA 自动 |
| **Chain of Thought** | 无 | 原生支持 |
| **新增依赖** | 0 | 1 个 npm 包（零外部依赖） |
| **CLI 命令变化** | 无 | + `ebrain optimize` |
| **用户感知** | 无变化 | 无变化（Phase 1-3），更准（Phase 4） |
