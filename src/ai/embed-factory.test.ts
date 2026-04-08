import { describe, expect, test, afterEach, mock } from "bun:test";
import { createBrainEmbeddingFunction } from "./embed-factory";
import { LocalHashEmbeddingFunction } from "./hash-embed";

describe("createBrainEmbeddingFunction", () => {
  const originalEnv = { ...process.env };

  function resetEmbedEnv() {
    const keys = [
      "EBRAIN_EMBED_PROVIDER",
      "EBRAIN_EMBED_BASE_URL",
      "EBRAIN_EMBED_MODEL",
      "EBRAIN_EMBED_DIMENSIONS",
      "EBRAIN_EMBED_API_KEY",
      "EBRAIN_EMBED_API_KEY_ENV",
      "DASHSCOPE_API_KEY",
    ];
    for (const key of keys) {
      delete process.env[key];
    }
  }

  afterEach(() => {
    resetEmbedEnv();
    for (const key of Object.keys(originalEnv)) {
      process.env[key] = originalEnv[key]!;
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
  });

  describe("hash provider (default)", () => {
    test("returns LocalHashEmbeddingFunction by default", () => {
      const fn = createBrainEmbeddingFunction();
      expect(fn).toBeInstanceOf(LocalHashEmbeddingFunction);
    });

    test("returns LocalHashEmbeddingFunction when provider is hash", () => {
      const fn = createBrainEmbeddingFunction({
        provider: "hash",
        baseURL: "",
        model: "",
        dimensions: 384,
        apiKey: "",
        apiKeyEnv: "",
      });
      expect(fn).toBeInstanceOf(LocalHashEmbeddingFunction);
    });

    test("no warnings when hash provider is used", () => {
      // Capture console.warn
      const warnMock = mock(() => {});
      const originalWarn = console.warn;
      console.warn = warnMock;

      createBrainEmbeddingFunction();

      console.warn = originalWarn;
      expect(warnMock).not.toHaveBeenCalled();
    });
  });

  describe("openai_compatible provider", () => {
    test("falls back to hash when no API key", () => {
      // Suppress the warning
      const originalWarn = console.warn;
      console.warn = () => {};

      const fn = createBrainEmbeddingFunction({
        provider: "openai_compatible",
        baseURL: "https://api.example.com/v1",
        model: "text-embedding-3-small",
        dimensions: 1536,
        apiKey: "",
        apiKeyEnv: "NONEXISTENT_KEY_VAR",
      });

      console.warn = originalWarn;
      expect(fn).toBeInstanceOf(LocalHashEmbeddingFunction);
    });

    test("uses direct apiKey when provided", () => {
      const fn = createBrainEmbeddingFunction({
        provider: "openai_compatible",
        baseURL: "https://api.example.com/v1",
        model: "text-embedding-3-small",
        dimensions: 1536,
        apiKey: "sk-direct-key",
        apiKeyEnv: "NONEXISTENT_KEY_VAR",
      });

      // Should return OpenAIEmbeddingFunction (not hash)
      expect(fn).not.toBeInstanceOf(LocalHashEmbeddingFunction);
      expect(fn.name).toContain("openai");
    });

    test("falls back to env var key when direct apiKey is empty", () => {
      process.env.MY_KEY = "sk-from-env";

      const fn = createBrainEmbeddingFunction({
        provider: "openai_compatible",
        baseURL: "https://api.example.com/v1",
        model: "text-embedding-3-small",
        dimensions: 1536,
        apiKey: "",
        apiKeyEnv: "MY_KEY",
      });

      expect(fn).not.toBeInstanceOf(LocalHashEmbeddingFunction);
      expect(fn.name).toContain("openai");
    });

    test("direct apiKey takes precedence over env var", () => {
      process.env.MY_KEY = "sk-env-var";

      const fn = createBrainEmbeddingFunction({
        provider: "openai_compatible",
        baseURL: "https://api.example.com/v1",
        model: "text-embedding-3-small",
        dimensions: 1536,
        apiKey: "sk-direct",
        apiKeyEnv: "MY_KEY",
      });

      expect(fn).not.toBeInstanceOf(LocalHashEmbeddingFunction);
    });
  });

  describe("legacy env var mode (no resolved settings)", () => {
    test("env EBRAIN_EMBED_PROVIDER=hash returns LocalHashEmbeddingFunction", () => {
      process.env.EBRAIN_EMBED_PROVIDER = "hash";
      const fn = createBrainEmbeddingFunction();
      expect(fn).toBeInstanceOf(LocalHashEmbeddingFunction);
    });

    test("env EBRAIN_EMBED_PROVIDER=openai_compatible without key falls back to hash", () => {
      process.env.EBRAIN_EMBED_PROVIDER = "openai_compatible";
      delete process.env.DASHSCOPE_API_KEY;
      delete process.env.EBRAIN_EMBED_API_KEY;

      const originalWarn = console.warn;
      console.warn = () => {};
      const fn = createBrainEmbeddingFunction();
      console.warn = originalWarn;

      expect(fn).toBeInstanceOf(LocalHashEmbeddingFunction);
    });

    test("env DASHSCOPE_API_KEY enables openai_compatible", () => {
      process.env.EBRAIN_EMBED_PROVIDER = "openai_compatible";
      process.env.DASHSCOPE_API_KEY = "sk-test-key";

      const fn = createBrainEmbeddingFunction();
      expect(fn).not.toBeInstanceOf(LocalHashEmbeddingFunction);
    });

    test("env EBRAIN_EMBED_API_KEY takes precedence over DASHSCOPE_API_KEY", () => {
      process.env.EBRAIN_EMBED_PROVIDER = "openai_compatible";
      process.env.EBRAIN_EMBED_API_KEY = "sk-direct";
      process.env.DASHSCOPE_API_KEY = "sk-fallback";

      const fn = createBrainEmbeddingFunction();
      expect(fn).not.toBeInstanceOf(LocalHashEmbeddingFunction);
    });

    test("invalid dimensions throws error", () => {
      process.env.EBRAIN_EMBED_PROVIDER = "openai_compatible";
      process.env.EBRAIN_EMBED_DIMENSIONS = "-1";
      process.env.EBRAIN_EMBED_API_KEY = "sk-test";

      expect(() => createBrainEmbeddingFunction()).toThrow(
        "EBRAIN_EMBED_DIMENSIONS must be a positive number",
      );
    });

    test("non-numeric dimensions throws error", () => {
      process.env.EBRAIN_EMBED_PROVIDER = "openai_compatible";
      process.env.EBRAIN_EMBED_DIMENSIONS = "abc";
      process.env.EBRAIN_EMBED_API_KEY = "sk-test";

      expect(() => createBrainEmbeddingFunction()).toThrow(
        "EBRAIN_EMBED_DIMENSIONS must be a positive number",
      );
    });
  });
});
