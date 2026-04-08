import { test, expect, describe } from "bun:test";
import { compileTruth, type CompileInput } from "./compiler";
import type { ResolvedLLM } from "../settings";

const mockLLM: ResolvedLLM = {
  baseURL: "",
  model: "qwen-plus",
  apiKey: "",
  apiKeyEnv: "DASHSCOPE_API_KEY",
};

describe("Compiler > Fallback behavior (no LLM key)", () => {
  test("falls back to append when no API key configured", async () => {
    const input: CompileInput = {
      currentTruth: "- **Funding Stage**: Seed\n- **Valuation**: ~$10M",
      timeline: [],
      newInfo: "River AI closed Series A funding",
      source: "meeting_notes",
      date: "2024-05-20",
      pageContext: {
        slug: "companies/river-ai",
        type: "company",
        title: "River AI",
      },
    };

    const result = await compileTruth(input, mockLLM);
    expect(result.changed).toBe(true);
    expect(result.changeType).toBe("append");
    expect(result.compiledTruth).toContain("River AI closed Series A funding");
    expect(result.compiledTruth).toContain("Source: meeting_notes");
    expect(result.confidence).toBe(0.5);
  });

  test("appends new facts to empty compiled truth", async () => {
    const input: CompileInput = {
      currentTruth: "",
      timeline: [],
      newInfo: "Founded in 2020 by John Doe",
      source: "research",
      date: "2024-01-15",
    };

    const result = await compileTruth(input, mockLLM);
    expect(result.compiledTruth).toContain("Founded in 2020");
    expect(result.compiledTruth).toContain("Source: research");
  });

  test("preserves existing content when appending", async () => {
    const input: CompileInput = {
      currentTruth: "## Status\n\n- Active\n\n## Facts\n\n- Old fact",
      timeline: [],
      newInfo: "New information arrived",
      source: "update",
      date: "2024-03-01",
    };

    const result = await compileTruth(input, mockLLM);
    expect(result.compiledTruth).toContain("Old fact");
    expect(result.compiledTruth).toContain("New information");
    expect(result.compiledTruth).toContain("Active");
  });

  test("creates ## Facts section when missing", async () => {
    const input: CompileInput = {
      currentTruth: "## Status\n\n- Active",
      timeline: [],
      newInfo: "New update",
      source: "user",
      date: "2024-06-01",
    };

    const result = await compileTruth(input, mockLLM);
    expect(result.compiledTruth).toContain("## Facts");
    expect(result.compiledTruth).toContain("New update");
  });
});

describe("Compiler > Timeline extraction fallback", () => {
  test("valid result structure returned", async () => {
    const input: CompileInput = {
      currentTruth: "- **Status**: Seed stage",
      timeline: [],
      newInfo: "Series A funding closed on 2024-05-20",
      source: "news",
      date: "2024-05-20",
    };

    const result = await compileTruth(input, mockLLM);
    expect(result).toHaveProperty("timelineEntries");
    expect(Array.isArray(result.timelineEntries)).toBe(true);
    expect(result).toHaveProperty("compiledTruth");
    expect(result).toHaveProperty("changed");
    expect(result).toHaveProperty("changeType");
    expect(result).toHaveProperty("changeSummary");
    expect(result).toHaveProperty("confidence");
  });
});
