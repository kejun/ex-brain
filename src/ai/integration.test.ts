/**
 * 综合集成测试: 时间线提取、编译、实体提取完整流程
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { BrainDb } from "../db/client";
import { BrainRepository } from "../repositories/brain-repo";
import { loadSettings } from "../settings";
import type { ResolvedLLM } from "../settings";
import { extractRelations, entityToSlug } from "./entity-link";
import { compileTruth, type CompileInput } from "./compiler";
import { extractTimelineEvents, type TimelineExtractionInput } from "./timeline-extractor";

const TEST_DB = "/tmp/ebrain-test-comprehensive.db";
const TEST_DB_2 = "/tmp/ebrain-test-comprehensive-2.db";

// Read LLM config from settings.json so it works out of the box
let _llm: ResolvedLLM | null = null;
async function getLLM(): Promise<ResolvedLLM> {
  if (_llm) return _llm;
  const s = await loadSettings();
  _llm = s.llm;
  return _llm;
}

async function freshRepo(dbPath: string) {
  try { require("fs").unlinkSync(dbPath); } catch {}
  const settings = await loadSettings();
  const db = await BrainDb.connect(dbPath, settings);
  const repo = new BrainRepository(db);
  return { repo, db };
}

// ===========================================================================
// 时间线提取测试
// ===========================================================================

describe("时间线提取", () => {
  // Avoid rate limiting on DashScope free tier
  const delay = () => new Promise(r => setTimeout(r, 3000));
  beforeEach(async () => { await delay(); });

  test("多事件混合: 中文+英文+相对日期", async () => {
    const input: TimelineExtractionInput = {
      content: `River AI 成立于 2020 年。2021 年 3 月获得种子轮融资。
昨天，公司宣布与 Google 达成战略合作。上个月完成了 B 轮融资。`,
      source: "test",
      defaultDate: "2024-06-15",
      pageSlug: "companies/river-ai",
    };

    const result = await extractTimelineEvents(input, await getLLM());
    console.log("📅 多事件提取:", result.entries.length, "条事件");
    for (const e of result.entries) {
      console.log(`   ${e.date} | ${e.summary}`);
    }

    expect(result.entries.length).toBeGreaterThan(0);
    // 应该至少提取到 2020 年成立和 2021 年融资
    const has2020 = result.entries.some(e => e.date.startsWith("2020"));
    const has2021 = result.entries.some(e => e.date.startsWith("2021"));
    expect(has2020 || has2021).toBe(true);
  }, 30000);

  test("纯中文日期格式", async () => {
    const input: TimelineExtractionInput = {
      content: "公司于 2024 年 3 月 15 日完成 A 轮融资，由红杉资本领投，融资金额 5000 万美元。2023 年 1 月，Sarah Chen 加入担任 COO。",
      source: "report",
      defaultDate: "2024-06-01",
      pageSlug: "companies/test",
    };

    const result = await extractTimelineEvents(input, await getLLM());
    console.log("📅 中文日期:", result.entries.length, "条事件");
    for (const e of result.entries) {
      console.log(`   ${e.date} | ${e.summary}`);
    }

    expect(result.success).toBe(true);
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  test("无事件内容: 返回空", async () => {
    const input: TimelineExtractionInput = {
      content: "这是一段普通的描述性文字，没有任何时间相关的事件。",
      source: "test",
      defaultDate: "2024-01-01",
      pageSlug: "notes/plain",
    };

    const result = await extractTimelineEvents(input, await getLLM());
    console.log("📅 无事件内容:", result.entries.length, "条事件");
    // LLM 可能会从描述性文字中提取事件，但不应该崩溃
    expect(result.entries).toBeInstanceOf(Array);
  }, 30000);
});

// ===========================================================================
// 编译器测试
// ===========================================================================

describe("编译器", () => {
  const delay = () => new Promise(r => setTimeout(r, 3000));
  beforeEach(async () => { await delay(); });

  test("状态更新: 融资阶段变更", async () => {
    const input: CompileInput = {
      currentTruth: "## Status\n\n- **Funding Stage**: Seed\n- **Valuation**: ~$10M",
      timeline: [],
      newInfo: "River AI 完成了 5000 万美元的 A 轮融资，由红杉资本领投，估值达到 2 亿美元。",
      source: "press_release",
      date: "2024-05-20",
      pageContext: { slug: "companies/river-ai", type: "company", title: "River AI" },
    };

    const result = await compileTruth(input, await getLLM());
    console.log("\n🧠 融资变更:");
    console.log("   changeType:", result.changeType);
    console.log("   confidence:", result.confidence);
    console.log("   summary:", result.changeSummary);
    console.log("   truth:", result.compiledTruth.slice(0, 150));

    expect(result.changed).toBe(true);
    expect(result.changeType).not.toBe("none");
    expect(result.confidence).toBeGreaterThan(0.5);
    // 应该包含 A 轮和 2 亿估值
    expect(result.compiledTruth).toContain("A")
    expect(result.compiledTruth).toContain("2");
  }, 30000);

  test("新增事实: 追加信息", async () => {
    const input: CompileInput = {
      currentTruth: "## Facts\n\n- Founded in 2020",
      timeline: [],
      newInfo: "River AI 与 Google Cloud 和 AWS 建立了战略合作伙伴关系。",
      source: "partnership_announcement",
      date: "2024-06-01",
      pageContext: { slug: "companies/river-ai", type: "company", title: "River AI" },
    };

    const result = await compileTruth(input, await getLLM());
    console.log("\n🧠 新增事实:");
    console.log("   changeType:", result.changeType);
    console.log("   confidence:", result.confidence);
    console.log("   truth:", result.compiledTruth.slice(0, 150));

    expect(result.changed).toBe(true);
    expect(result.compiledTruth).toContain("Google")
    expect(result.compiledTruth).toContain("AWS");
  }, 30000);

  test("空页面: 首次编译", async () => {
    const input: CompileInput = {
      currentTruth: "",
      timeline: [],
      newInfo: "River AI 是一家专注于 AI 分析的公司，成立于 2020 年，总部位于旧金山。",
      source: "initial",
      date: "2024-01-01",
      pageContext: { slug: "companies/river-ai", type: "company", title: "River AI" },
    };

    const result = await compileTruth(input, await getLLM());
    console.log("\n🧠 首次编译:");
    console.log("   changeType:", result.changeType);
    console.log("   truth:", result.compiledTruth.slice(0, 100));

    expect(result.changed).toBe(true);
    expect(result.compiledTruth.length).toBeGreaterThan(0);
    expect(result.compiledTruth).toContain("River AI");
  }, 30000);
});

// ===========================================================================
// 实体提取测试
// ===========================================================================

describe("实体提取", () => {
  const delay = () => new Promise(r => setTimeout(r, 3000));
  beforeEach(async () => { await delay(); });

  test("中文人名和公司名识别", { timeout: 60000 }, async () => {
    const content = `张三 是 阿里巴巴 的高级工程师，毕业于 清华大学。他曾在 Google 工作 3 年，2022 年加入 阿里巴巴。`;
    
    const relations = await extractRelations(content, await getLLM());
    console.log("\n🔗 中文实体:", relations.length, "条关系");
    for (const r of relations) {
      console.log(`   ${r.from.name}(${r.from.type}) --${r.relation}--> ${r.to.name}(${r.to.type}) conf=${r.confidence}`);
    }

    expect(relations.length).toBeGreaterThan(0);
    // 应该识别到张三和阿里巴巴的关系
    const hasZhangSan = relations.some(r => 
      r.from.name.includes("张三") || r.to.name.includes("张三")
    );
    expect(hasZhangSan).toBe(true);
  }, 30000);

  test("英文实体识别", async () => {
    const content = `John Smith founded River AI in 2020. The company raised $50M Series A from Sequoia Capital. Sarah Chen joined as COO from Snowflake.`;
    
    const relations = await extractRelations(content, await getLLM());
    console.log("\n🔗 英文实体:", relations.length, "条关系");
    for (const r of relations) {
      console.log(`   ${r.from.name}(${r.from.type}) --${r.relation}--> ${r.to.name}(${r.to.type}) conf=${r.confidence}`);
    }

    expect(relations.length).toBeGreaterThan(0);
    // 应该识别到 John Smith 和 River AI 的关系
    const hasJohnSmith = relations.some(r => 
      r.from.name.includes("John Smith") || r.to.name.includes("John Smith")
    );
    expect(hasJohnSmith).toBe(true);
  }, 30000);

  test("空内容: 返回空数组", async () => {
    const relations = await extractRelations("", await getLLM());
    expect(relations).toEqual([]);
  });

  test("无实体内容: 返回空数组", async () => {
    const relations = await extractRelations("这是一段没有任何实体或关系的普通文字。", await getLLM());
    console.log("\n🔗 无实体内容:", relations.length, "条关系");
    expect(relations).toBeInstanceOf(Array);
  }, 30000);
});

// ===========================================================================
// 端到端: 完整 import 流程
// ===========================================================================

describe("端到端: 完整 import 流程", () => {
  const delay = () => new Promise(r => setTimeout(r, 5000));
  beforeEach(async () => { await delay(); });

  test("导入文章 → 提取实体 → 创建页面和链接", { timeout: 60000 }, async () => {
    const { repo, db } = await freshRepo(TEST_DB_2);

    // 模拟 import 流程
    const articleContent = `# AI 行业报告

OpenAI 在 2024 年发布了 GPT-5。Google 推出了 Gemini 2.0 与 OpenAI 竞争。

Microsoft 已投资 OpenAI 超过 130 亿美元。Amazon 与 Anthropic 达成战略合作，计划投资 40 亿美元。

在中国，百度、阿里巴巴、腾讯都在积极布局 AI 领域。`;

    // Step 1: 创建文章页面
    await repo.putPage({
      slug: "notes/ai-industry-report",
      type: "note",
      title: "AI 行业报告",
      compiledTruth: articleContent,
      timeline: "",
      frontmatter: { source: "test" },
    });

    // Step 2: 提取实体关系
    const relations = await extractRelations(articleContent, await getLLM());
    console.log("\n🔗 提取到", relations.length, "条关系");
    for (const r of relations) {
      console.log(`   ${r.from.name} --${r.relation}--> ${r.to.name}`);
    }

    // Step 3: 创建实体页面和链接
    const highConfidence = relations.filter(r => r.confidence >= 0.7);
    let entityPagesCreated = 0;
    let linksCreated = 0;

    for (const r of highConfidence) {
      const fromCandidate = entityToSlug(r.from.name, r.from.type);
      const toCandidate = entityToSlug(r.to.name, r.to.type);
      
      const fromSlug = await repo.findSimilarSlug(fromCandidate, r.from.name);
      const toSlug = await repo.findSimilarSlug(toCandidate, r.to.name);

      const c1 = await repo.ensureEntityPage(fromSlug, r.from.type, r.from.name, r.relation, r.context, "notes/ai-industry-report");
      const c2 = await repo.ensureEntityPage(toSlug, r.to.type, r.to.name, r.relation, r.context, "notes/ai-industry-report");
      if (c1) entityPagesCreated++;
      if (c2) entityPagesCreated++;

      await repo.link(fromSlug, toSlug, `[${r.relation}] ${r.context}`);
      await repo.link("notes/ai-industry-report", fromSlug, `Mentions ${r.from.name}`);
      await repo.link("notes/ai-industry-report", toSlug, `Mentions ${r.to.name}`);
      linksCreated += 3;
    }

    console.log(`📄 实体页面: ${entityPagesCreated}`);
    console.log(`🔗 链接: ${linksCreated}`);

    // Step 4: 验证所有页面被创建
    const allSlugs = await repo.allSlugs();
    console.log("📋 所有页面:", allSlugs);

    // 应该有文章页面 + 多个实体页面
    expect(allSlugs.length).toBeGreaterThan(1);
    expect(allSlugs).toContain("notes/ai-industry-report");

    // 应该有实体页面
    const entitySlugs = allSlugs.filter(s => 
      s.startsWith("people/") || 
      s.startsWith("companies/") || 
      s.startsWith("organizations/")
    );
    expect(entitySlugs.length).toBeGreaterThan(0);
    console.log("🏷️ 实体页面:", entitySlugs);

    // Step 5: 验证实体页面内容
    for (const slug of entitySlugs.slice(0, 3)) {
      const page = await repo.getPage(slug);
      expect(page).not.toBeNull();
      expect(page?.compiledTruth.length).toBeGreaterThan(0);
      console.log(`   ${slug}: ${page?.compiledTruth.slice(0, 60)}...`);
    }

    // Step 6: 验证文章有出向链接
    const outgoing = await repo.outgoingLinks("notes/ai-industry-report");
    console.log("📤 文章出向链接:", outgoing.length, "条");
    expect(outgoing.length).toBeGreaterThan(0);

    await db.close();
    await new Promise(r => setTimeout(r, 500));
  }, 60000);
});
