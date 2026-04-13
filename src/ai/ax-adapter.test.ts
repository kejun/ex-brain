import { test, expect, describe } from "bun:test";
import { createAxAI, resolveApiKey, isConfigured } from "./ax-adapter";
import type { ResolvedLLM } from "../settings";

describe("ax-adapter > resolveApiKey", () => {
  test("returns direct apiKey when present", () => {
    const llm: ResolvedLLM = {
      baseURL: "https://api.example.com/",
      model: "gpt-4",
      apiKey: "sk-direct",
      apiKeyEnv: "SOME_KEY",
    };
    expect(resolveApiKey(llm)).toBe("sk-direct");
  });

  test("falls back to env var when apiKey is empty", () => {
    process.env.TEST_AX_KEY = "sk-from-env";
    const llm: ResolvedLLM = {
      baseURL: "",
      model: "qwen-plus",
      apiKey: "",
      apiKeyEnv: "TEST_AX_KEY",
    };
    expect(resolveApiKey(llm)).toBe("sk-from-env");
    delete process.env.TEST_AX_KEY;
  });

  test("returns empty string when no key available", () => {
    const llm: ResolvedLLM = {
      baseURL: "",
      model: "qwen-plus",
      apiKey: "",
      apiKeyEnv: "NONEXISTENT_KEY",
    };
    expect(resolveApiKey(llm)).toBe("");
  });
});

describe("ax-adapter > isConfigured", () => {
  test("returns true when apiKey is present", () => {
    const llm: ResolvedLLM = {
      baseURL: "",
      model: "qwen-plus",
      apiKey: "sk-key",
      apiKeyEnv: "",
    };
    expect(isConfigured(llm)).toBe(true);
  });

  test("returns false when no key available", () => {
    const llm: ResolvedLLM = {
      baseURL: "",
      model: "qwen-plus",
      apiKey: "",
      apiKeyEnv: "NONEXISTENT",
    };
    expect(isConfigured(llm)).toBe(false);
  });
});

describe("ax-adapter > createAxAI", () => {
  test("returns null when no API key", () => {
    const llm: ResolvedLLM = {
      baseURL: "",
      model: "qwen-plus",
      apiKey: "",
      apiKeyEnv: "NONEXISTENT",
    };
    expect(createAxAI(llm)).toBeNull();
  });

  test("creates AxAI instance with apiKey", () => {
    const llm: ResolvedLLM = {
      baseURL: "",
      model: "qwen-plus",
      apiKey: "sk-test",
      apiKeyEnv: "",
    };
    const aiInstance = createAxAI(llm);
    expect(aiInstance).not.toBeNull();
    // Ax stores model info internally; the key check is that creation succeeds
  });

  test("creates AxAI instance with custom baseURL", () => {
    const llm: ResolvedLLM = {
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
      apiKey: "sk-test",
      apiKeyEnv: "",
    };
    const ai = createAxAI(llm);
    expect(ai).not.toBeNull();
  });
});
