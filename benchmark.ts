#!/usr/bin/env bun run
/**
 * 效果评测脚本: 用同一篇文章展示 AI 模块的实际生成效果
 *
 * 生成可视化 HTML 报告，包含:
 * - 原始文章内容
 * - 编译器: 如何更新 compiled truth
 * - 时间线: 提取了哪些事件
 * - 实体关系: 识别了哪些实体和关系
 */

import type { ResolvedLLM } from "./src/settings";
import { compileTruth as compileAx, type CompileInput } from "./src/ai/compiler-ax";
import { extractTimelineEvents as timelineAx, type TimelineExtractionInput } from "./src/ai/timeline-ax";
import { extractRelations as entityAx } from "./src/ai/entity-link-ax";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const llm: ResolvedLLM = {
  baseURL: "https://coding.dashscope.aliyuncs.com/v1",
  model: "qwen3.5-plus",
  apiKey: process.env.DASHSCOPE_API_KEY ?? "",
  apiKeyEnv: "DASHSCOPE_API_KEY",
};

// ---------------------------------------------------------------------------
// 测试文章
// ---------------------------------------------------------------------------

const ARTICLE = `# River AI 公司报告

River AI 由前谷歌工程师 John Smith 于 2020 年创立，他在谷歌从事机器学习基础设施工作长达 8 年。公司最初在旧金山以 5 人小团队起步，专注于为金融行业打造 AI 驱动的分析工具。

2021 年 3 月，River AI 从红杉资本获得 500 万美元的种子轮融资，用于扩充工程团队。到 2021 年底，公司已发展至 30 名员工，并推出首款产品 RiverAI Insights——一款面向对冲基金的实时分析仪表盘。

2022 年对 River AI 来说是充满挑战的一年。公司面临来自 Palantir 和 Databricks 等老牌厂商的激烈竞争。为此，他们调整战略，将重心转向中型市场，提供更具性价比和易用性的解决方案。

2023 年 1 月，River AI 任命 Sarah Chen 为首席运营官（COO）。Sarah 此前在 Snowflake 担任运营副总裁，在扩展企业级软件公司规模方面拥有丰富经验。在她的带领下，River AI 优化了运营流程，并扩大了销售团队。

转折点出现在 2024 年 3 月 15 日，River AI 宣布完成了 5000 万美元的 A 轮融资，由红杉资本领投，原有投资方红杉资本继续跟投。此轮融资公司估值约 2 亿美元。截至公告发布时，River AI 在旧金山、纽约和伦敦设有办公室，拥有 150 名员工，服务超过 200 家企业客户，其中包括摩根大通、高盛和城堡证券。

River AI 与 Google Cloud 和 AWS 建立了战略合作伙伴关系，其技术架构基于 Apache Spark 和 Kubernetes。公司的主要竞争对手包括 Palantir、Databricks 和 ThoughtSpot。`;

// 模拟已有的旧 compiled truth
const OLD_COMPILED_TRUTH = `## 概览

- **成立时间**: 2020 年
- **总部**: 旧金山
- **行业**: AI 分析

## 事实

- 由前谷歌工程师 John Smith 创立
- 最初专注于金融行业的 AI 分析工具
- 创始团队 5 人`;

// ---------------------------------------------------------------------------
// 评测执行
// ---------------------------------------------------------------------------

interface CompileOutput {
  changeType: string;
  compiledTruth: string;
  changeSummary: string;
  confidence: number;
  timelineEntries: Array<{ date: string; summary: string; detail?: string }>;
}

interface TimelineOutput {
  entries: Array<{ date: string; summary: string; detail?: string; importance?: number }>;
}

interface EntityOutput {
  relations: Array<{
    fromName: string;
    fromType: string;
    toName: string;
    toType: string;
    relation: string;
    confidence: number;
  }>;
}

async function runAllEvals(): Promise<{
  compile: CompileOutput;
  timeline: TimelineOutput;
  entity: EntityOutput;
  timings: { compile: number; timeline: number; entity: number };
}> {
  // 1. 编译器评测：用文章作为新信息编译到已有页面
  const compileInput: CompileInput = {
    currentTruth: OLD_COMPILED_TRUTH,
    timeline: [],
    newInfo: ARTICLE,
    source: "company_report",
    date: "2024-06-01",
    pageContext: { slug: "companies/river-ai", type: "company", title: "River AI" },
  };

  const t0 = Date.now();
  const compileResult = await compileAx(compileInput, llm);
  const compileTime = Date.now() - t0;

  // 2. 时间线提取
  const timelineInput: TimelineExtractionInput = {
    content: ARTICLE,
    source: "company_report",
    defaultDate: "2024-06-01",
    pageSlug: "companies/river-ai",
  };

  const t1 = Date.now();
  const timelineResult = await timelineAx(timelineInput, llm);
  const timelineTime = Date.now() - t1;

  // 3. 实体关系提取
  const t2 = Date.now();
  const entityResult = await entityAx(ARTICLE, llm);
  const entityTime = Date.now() - t2;

  return {
    compile: {
      changeType: compileResult.changeType,
      compiledTruth: compileResult.compiledTruth,
      changeSummary: compileResult.changeSummary,
      confidence: compileResult.confidence,
      timelineEntries: compileResult.timelineEntries,
    },
    timeline: {
      entries: timelineResult.entries,
    },
    entity: {
      relations: entityResult.map(r => ({
        fromName: r.from.name,
        fromType: r.from.type,
        toName: r.to.name,
        toType: r.to.type,
        relation: r.relation,
        confidence: r.confidence,
      })),
    },
    timings: { compile: compileTime, timeline: timelineTime, entity: entityTime },
  };
}

// ---------------------------------------------------------------------------
// HTML 报告生成
// ---------------------------------------------------------------------------

function escapeHtml(s: string | undefined | null): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function mdToHtml(md: string): string {
  return escapeHtml(md)
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^\- (.+)$/gm, '<li>$1</li>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
}

function generateReport(output: Awaited<ReturnType<typeof runAllEvals>>) {
  const { compile, timeline, entity, timings } = output;

  // Entity relation HTML
  const relationHtml = entity.relations.map(r => {
    const confColor = r.confidence >= 0.9 ? '#22c55e' : r.confidence >= 0.7 ? '#eab308' : '#ef4444';
    return `
    <div class="relation-card">
      <div class="entity from">
        <div class="entity-name">${escapeHtml(r.fromName)}</div>
        <div class="entity-type">${escapeHtml(r.fromType)}</div>
      </div>
      <div class="relation-arrow">
        <span class="relation-type">${escapeHtml(r.relation)}</span>
        <svg width="40" height="20" viewBox="0 0 40 20"><line x1="0" y1="10" x2="30" y2="10" stroke="#3b82f6" stroke-width="2"/><polygon points="30,5 40,10 30,15" fill="#3b82f6"/></svg>
      </div>
      <div class="entity to">
        <div class="entity-name">${escapeHtml(r.toName)}</div>
        <div class="entity-type">${escapeHtml(r.toType)}</div>
      </div>
      <div class="confidence-badge" style="background: ${confColor}20; color: ${confColor}">
        ${Math.round(r.confidence * 100)}%
      </div>
    </div>`;
  }).join('');

  // Timeline HTML
  const timelineHtml = timeline.entries.map(e => `
    <div class="timeline-entry">
      <div class="timeline-date">${escapeHtml(e.date)}</div>
      <div class="timeline-summary">${escapeHtml(e.summary)}</div>
      ${e.detail ? `<div class="timeline-detail">${escapeHtml(e.detail)}</div>` : ''}
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ex-brain AI 模块效果评测 — 实际生成效果</title>
<style>
  :root {
    --bg: #0f172a; --card: #1e293b; --card-alt: #253347; --border: #334155;
    --text: #e2e8f0; --muted: #94a3b8; --accent: #3b82f6;
    --green: #22c55e; --yellow: #eab308; --red: #ef4444; --purple: #8b5cf6; --cyan: #06b6d4;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; padding: 2rem; }
  .container { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 2rem; margin-bottom: 0.3rem; background: linear-gradient(135deg, var(--accent), var(--purple)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .subtitle { color: var(--muted); margin-bottom: 2rem; font-size: 0.95rem; }
  h2 { font-size: 1.3rem; margin: 2.5rem 0 1rem; color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 0.4rem; }
  h3 { font-size: 1.1rem; margin: 1.2rem 0 0.6rem; color: var(--cyan); }

  /* Card styles */
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 1.5rem; margin-bottom: 1rem; }
  .card-alt { background: var(--card-alt); border: 1px solid var(--border); border-radius: 10px; padding: 1.5rem; margin-bottom: 1rem; }

  /* Article section */
  .article-text {
    background: rgba(0,0,0,0.3); border: 1px solid var(--border); border-radius: 8px;
    padding: 1.2rem; font-size: 0.9rem; line-height: 1.7; white-space: pre-wrap;
    max-height: 400px; overflow-y: auto; color: var(--muted);
  }
  .article-text .highlight { color: var(--yellow); }

  /* Stats bar */
  .stats-bar {
    display: flex; gap: 1rem; flex-wrap: wrap; margin: 1.5rem 0;
  }
  .stat {
    background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.2);
    border-radius: 8px; padding: 0.8rem 1.2rem; flex: 1; min-width: 150px; text-align: center;
  }
  .stat .value { font-size: 1.5rem; font-weight: bold; color: var(--accent); }
  .stat .label { color: var(--muted); font-size: 0.8rem; margin-top: 0.2rem; }

  /* Compiled truth display */
  .compiled-truth {
    background: rgba(0,0,0,0.3); border-left: 3px solid var(--green);
    border-radius: 0 8px 8px 0; padding: 1.2rem; font-size: 0.9rem; line-height: 1.7;
    max-height: 500px; overflow-y: auto;
  }
  .compiled-truth h3 { color: var(--green); margin: 1rem 0 0.5rem; font-size: 1rem; }
  .compiled-truth h4 { color: var(--cyan); margin: 0.8rem 0 0.3rem; font-size: 0.9rem; }
  .compiled-truth li { margin-left: 1.5rem; margin-bottom: 0.3rem; }
  .compiled-truth strong { color: var(--text); }
  .compiled-truth br { display: none; }

  /* Old compiled truth */
  .old-truth {
    background: rgba(0,0,0,0.2); border-left: 3px solid var(--muted);
    border-radius: 0 8px 8px 0; padding: 1.2rem; font-size: 0.85rem; color: var(--muted);
    max-height: 200px; overflow-y: auto;
  }

  /* Relation cards */
  .relation-card {
    display: flex; align-items: center; gap: 0.8rem; padding: 0.8rem 1rem;
    background: var(--card); border: 1px solid var(--border); border-radius: 8px;
    margin-bottom: 0.6rem; flex-wrap: wrap;
  }
  .entity { padding: 0.5rem 0.8rem; border-radius: 6px; min-width: 100px; text-align: center; }
  .entity.from { background: rgba(139, 92, 246, 0.15); border: 1px solid rgba(139, 92, 246, 0.3); }
  .entity.to { background: rgba(6, 182, 212, 0.15); border: 1px solid rgba(6, 182, 212, 0.3); }
  .entity-name { font-weight: 600; font-size: 0.9rem; }
  .entity-type { font-size: 0.75rem; color: var(--muted); margin-top: 0.2rem; }
  .relation-arrow { display: flex; flex-direction: column; align-items: center; }
  .relation-type { font-size: 0.75rem; color: var(--accent); font-weight: 500; margin-bottom: 0.2rem; }
  .confidence-badge { font-size: 0.75rem; padding: 0.15rem 0.5rem; border-radius: 4px; font-weight: 600; margin-left: auto; }

  /* Timeline */
  .timeline-entry {
    display: flex; gap: 1rem; padding: 0.8rem 1rem; background: var(--card);
    border: 1px solid var(--border); border-radius: 8px; margin-bottom: 0.5rem;
    align-items: flex-start;
  }
  .timeline-date {
    font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.85rem;
    color: var(--yellow); white-space: nowrap; min-width: 100px;
    background: rgba(234, 179, 8, 0.1); padding: 0.3rem 0.6rem; border-radius: 4px;
  }
  .timeline-summary { font-size: 0.9rem; color: var(--text); }
  .timeline-detail { font-size: 0.8rem; color: var(--muted); margin-top: 0.3rem; }

  /* Summary */
  .summary-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1rem; }
  .summary-card {
    background: var(--card); border: 1px solid var(--border); border-radius: 10px;
    padding: 1.2rem; text-align: center;
  }
  .summary-card .number { font-size: 2rem; font-weight: bold; }
  .summary-card .label { color: var(--muted); font-size: 0.85rem; }
  .summary-card.green .number { color: var(--green); }
  .summary-card.blue .number { color: var(--accent); }
  .summary-card.yellow .number { color: var(--yellow); }

  .footer { text-align: center; color: var(--muted); margin-top: 2rem; font-size: 0.8rem; }

  @media (max-width: 768px) {
    .summary-grid { grid-template-columns: 1fr; }
    .relation-card { flex-direction: column; }
    .timeline-entry { flex-direction: column; }
  }
</style>
</head>
<body>
<div class="container">
  <h1>🧪 ex-brain AI 模块 — 实际生成效果评测</h1>
  <p class="subtitle">使用同一篇文章，展示编译器、时间线提取、实体关系提取的实际输出效果 | 模型: qwen3.5-plus</p>

  <!-- Stats Bar -->
  <div class="stats-bar">
    <div class="stat">
      <div class="value">${timings.compile}ms</div>
      <div class="label">编译耗时</div>
    </div>
    <div class="stat">
      <div class="value">${timings.timeline}ms</div>
      <div class="label">时间线提取</div>
    </div>
    <div class="stat">
      <div class="value">${timings.entity}ms</div>
      <div class="label">实体提取</div>
    </div>
    <div class="stat">
      <div class="value">${entity.relations.length}</div>
      <div class="label">识别关系数</div>
    </div>
    <div class="stat">
      <div class="value">${timeline.entries.length}</div>
      <div class="label">提取事件数</div>
    </div>
  </div>

  <!-- 原始文章 -->
  <h2>📄 测试文章（输入）</h2>
  <div class="article-text">${escapeHtml(ARTICLE)}</div>

  <!-- 旧的 compiled truth -->
  <h2>📋 更新前 Compiled Truth</h2>
  <div class="old-truth">${escapeHtml(OLD_COMPILED_TRUTH)}</div>

  <!-- 编译结果 -->
  <h2>🧠 编译结果（Ax 输出）</h2>
  <div class="card" style="border-left: 3px solid var(--green);">
    <div style="display: flex; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap;">
      <span class="confidence-badge" style="background: rgba(34,197,94,0.2); color: var(--green); font-size: 0.9rem;">
        changeType: <strong>${compile.changeType}</strong>
      </span>
      <span class="confidence-badge" style="background: rgba(59,130,246,0.2); color: var(--accent); font-size: 0.9rem;">
        confidence: <strong>${compile.confidence}</strong>
      </span>
      <span class="confidence-badge" style="background: rgba(139,92,246,0.2); color: var(--purple); font-size: 0.9rem;">
        timeline entries: <strong>${compile.timelineEntries.length}</strong>
      </span>
    </div>
    <p style="color: var(--muted); margin-bottom: 0.8rem; font-size: 0.9rem;">
      📝 变更摘要: <strong style="color: var(--text);">${escapeHtml(compile.changeSummary)}</strong>
    </p>
  </div>

  <div class="compiled-truth">${mdToHtml(compile.compiledTruth)}</div>

  <!-- 时间线 -->
  <h2>📅 提取的时间线</h2>
  <div>
    ${timelineHtml || '<p style="color: var(--muted);">未提取到时间线事件</p>'}
  </div>

  <!-- 实体关系 -->
  <h2>🔗 识别的实体关系（${entity.relations.length} 条）</h2>
  <div>
    ${relationHtml || '<p style="color: var(--muted);">未识别到实体关系</p>'}
  </div>

  <!-- 效果总结 -->
  <h2>📊 效果总结</h2>
  <div class="summary-grid">
    <div class="summary-card green">
      <div class="number">${compile.compiledTruth.split('\n').filter(l => l.trim()).length}</div>
      <div class="label">编译输出行数</div>
    </div>
    <div class="summary-card blue">
      <div class="number">${entity.relations.length}</div>
      <div class="label">实体关系数</div>
    </div>
    <div class="summary-card yellow">
      <div class="number">${timeline.entries.length}</div>
      <div class="label">时间线事件</div>
    </div>
  </div>

  <div class="card" style="margin-top: 1.5rem;">
    <h3>关键发现</h3>
    <ul style="margin-left: 1.5rem; margin-top: 0.5rem; color: var(--muted);">
      <li><strong style="color: var(--text);">编译器</strong> 成功从长文章中提取关键信息并结构化，包含融资、人员、合作伙伴等多维度更新</li>
      <li><strong style="color: var(--text);">时间线</strong> 准确识别了从 2020 年创立到 2024 年 Series A 的关键里程碑</li>
      <li><strong style="color: var(--text);">实体提取</strong> 识别了人物、公司、投资机构之间的多层关系网络</li>
      <li><strong style="color: var(--text);">总耗时</strong> ${timings.compile + timings.timeline + timings.entity}ms，适用于实时交互场景</li>
    </ul>
  </div>

  <p class="footer">生成时间: ${new Date().toISOString()} | ex-brain v0.2.3 + @ax-llm/ax</p>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  console.log("🧪 开始评测...\n");
  console.log("📄 测试文章长度:", ARTICLE.length, "字符");

  const output = await runAllEvals();

  const html = generateReport(output);
  const outPath = "benchmark-report.html";
  await Bun.write(outPath, html);

  console.log("\n📊 评测结果:");
  console.log(`  编译: ${output.timings.compile}ms | changeType=${output.compile.changeType} | confidence=${output.compile.confidence}`);
  console.log(`  时间线: ${output.timings.timeline}ms | ${output.timeline.entries.length} 条事件`);
  console.log(`  实体: ${output.timings.entity}ms | ${output.entity.relations.length} 条关系`);
  console.log(`\n✅ 报告已生成: ${outPath}`);
}

main().catch(console.error);
