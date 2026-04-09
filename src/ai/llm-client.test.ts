import { describe, test, expect, beforeEach, vi } from "bun:test";
import { 
  callLLM, 
  resolveApiKey, 
  isLLMConfigured,
  LLMError,
  APIError,
  TimeoutError,
  RateLimitError,
} from "./llm-client";
import type { ResolvedLLM } from "../settings";

describe("llm-client", () => {
  const mockLLM: ResolvedLLM = {
    baseURL: "https://api.example.com/v1",
    model: "test-model",
    apiKey: "test-key",
    apiKeyEnv: "TEST_API_KEY",
  };

  describe("resolveApiKey", () => {
    test("returns direct apiKey when present", () => {
      const llm: ResolvedLLM = { ...mockLLM, apiKey: "direct-key" };
      expect(resolveApiKey(llm)).toBe("direct-key");
    });

    test("falls back to env var when apiKey is empty", () => {
      process.env.TEST_API_KEY = "env-key";
      const llm: ResolvedLLM = { ...mockLLM, apiKey: "" };
      expect(resolveApiKey(llm)).toBe("env-key");
      delete process.env.TEST_API_KEY;
    });

    test("returns empty string when no key available", () => {
      const llm: ResolvedLLM = { ...mockLLM, apiKey: "", apiKeyEnv: "NON_EXISTENT_VAR" };
      expect(resolveApiKey(llm)).toBe("");
    });
  });

  describe("isLLMConfigured", () => {
    test("returns true when apiKey is present", () => {
      expect(isLLMConfigured(mockLLM)).toBe(true);
    });

    test("returns true when env var is set", () => {
      process.env.TEST_API_KEY = "env-key";
      const llm: ResolvedLLM = { ...mockLLM, apiKey: "" };
      expect(isLLMConfigured(llm)).toBe(true);
      delete process.env.TEST_API_KEY;
    });

    test("returns false when no key available", () => {
      const llm: ResolvedLLM = { ...mockLLM, apiKey: "", apiKeyEnv: "NON_EXISTENT_VAR" };
      expect(isLLMConfigured(llm)).toBe(false);
    });
  });

  describe("callLLM", () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });

    test("returns empty string when no API key", async () => {
      const llm: ResolvedLLM = { ...mockLLM, apiKey: "" };
      const result = await callLLM(llm, "test prompt", 100);
      expect(result).toBe("");
    });

    test("returns empty string when baseURL is empty", async () => {
      const llm: ResolvedLLM = { ...mockLLM, baseURL: "" };
      const result = await callLLM(llm, "test prompt", 100);
      expect(result).toBe("");
    });
  });

  describe("Error classes", () => {
    test("LLMError has correct properties", () => {
      const error = new LLMError("test error", "TEST_CODE", 500, true);
      expect(error.message).toBe("test error");
      expect(error.code).toBe("TEST_CODE");
      expect(error.statusCode).toBe(500);
      expect(error.retryable).toBe(true);
      expect(error.name).toBe("LLMError");
    });

    test("APIError has correct properties", () => {
      const error = new APIError("api error", 400);
      expect(error.code).toBe("API_ERROR");
      expect(error.statusCode).toBe(400);
      expect(error.retryable).toBe(false);
      expect(error.name).toBe("APIError");
    });

    test("TimeoutError has correct properties", () => {
      const error = new TimeoutError();
      expect(error.code).toBe("TIMEOUT_ERROR");
      expect(error.retryable).toBe(true);
      expect(error.name).toBe("TimeoutError");
    });

    test("RateLimitError has correct properties", () => {
      const error = new RateLimitError("rate limited", 60);
      expect(error.code).toBe("RATE_LIMIT_ERROR");
      expect(error.statusCode).toBe(429);
      expect(error.retryable).toBe(true);
      expect(error.retryAfter).toBe(60);
      expect(error.name).toBe("RateLimitError");
    });
  });
});