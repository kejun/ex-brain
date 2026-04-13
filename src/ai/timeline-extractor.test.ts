import { test, expect, describe } from "bun:test";
import { extractTimelineEvents, type TimelineExtractionInput } from "./timeline-extractor";
import type { ResolvedLLM } from "../settings";

const mockLLM: ResolvedLLM = {
  baseURL: "",
  model: "qwen-plus",
  apiKey: "",
  apiKeyEnv: "DASHSCOPE_API_KEY",
};

describe("Timeline > Fallback regex extraction (no LLM key)", () => {
  test("extracts events with ISO dates", async () => {
    const input: TimelineExtractionInput = {
      content: "River AI closed Series A on 2024-01-15. The funding round was $50M.",
      source: "news",
      defaultDate: "2024-05-01",
      pageSlug: "companies/river-ai",
    };

    const result = await extractTimelineEvents(input, mockLLM);
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries[0]?.date).toMatch(/2024-01/);
  });

  test("extracts events from Chinese date format", async () => {
    const input: TimelineExtractionInput = {
      content: "公司在2024年1月15日完成了A轮融资。",
      source: "report",
      defaultDate: "2024-05-01",
      pageSlug: "companies/test",
    };

    const result = await extractTimelineEvents(input, mockLLM);
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries[0]?.date).toBe("2024-01-15");
  });

  test("uses default date for relative dates", async () => {
    const input: TimelineExtractionInput = {
      content: "The meeting happened yesterday and we discussed the roadmap.",
      source: "notes",
      defaultDate: "2024-05-20",
      pageSlug: "meetings/daily",
    };

    const result = await extractTimelineEvents(input, mockLLM);
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries[0]?.date).toMatch(/2024-05/);
  });

  test("returns empty when no events detected", async () => {
    const input: TimelineExtractionInput = {
      content: "This is just some random text without any dates or events.",
      source: "misc",
      defaultDate: "2024-01-01",
      pageSlug: "misc/notes",
    };

    const result = await extractTimelineEvents(input, mockLLM);
    expect(result.entries.length).toBe(0);
    expect(result.confidence).toBeLessThan(0.5);
  });

  test("returns empty for empty content", async () => {
    const input: TimelineExtractionInput = {
      content: "",
      source: "misc",
      defaultDate: "2024-01-01",
      pageSlug: "misc/notes",
    };

    const result = await extractTimelineEvents(input, mockLLM);
    expect(result.entries.length).toBe(0);
    expect(result.success).toBe(false);
  });

  test("extracts English month format", async () => {
    const input: TimelineExtractionInput = {
      content: "Product launched on January 20, 2024 with great success.",
      source: "news",
      defaultDate: "2024-05-01",
      pageSlug: "products/launch",
    };

    const result = await extractTimelineEvents(input, mockLLM);
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries[0]?.date).toBe("2024-01-20");
  });
});
