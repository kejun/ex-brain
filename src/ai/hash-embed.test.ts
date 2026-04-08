import { describe, expect, test } from "bun:test";
import { LocalHashEmbeddingFunction } from "./hash-embed";

describe("LocalHashEmbeddingFunction", () => {
  test("name is ebrain-local-hash", () => {
    const fn = new LocalHashEmbeddingFunction();
    expect(fn.name).toBe("ebrain-local-hash");
  });

  test("dimension is 384", () => {
    const fn = new LocalHashEmbeddingFunction();
    expect(fn.dimension).toBe(384);
    expect(fn.getConfig().dimension).toBe(384);
  });

  test("generates vectors of correct length", async () => {
    const fn = new LocalHashEmbeddingFunction();
    const vectors = await fn.generate(["hello"]);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(384);
  });

  test("generates multiple vectors", async () => {
    const fn = new LocalHashEmbeddingFunction();
    const vectors = await fn.generate(["a", "b", "c"]);
    expect(vectors).toHaveLength(3);
    for (const v of vectors) {
      expect(v).toHaveLength(384);
    }
  });

  test("deterministic: same input produces same output", async () => {
    const fn = new LocalHashEmbeddingFunction();
    const v1 = await fn.generate(["hello world"]);
    const v2 = await fn.generate(["hello world"]);
    expect(v1[0]).toEqual(v2[0]);
  });

  test("different inputs produce different vectors", async () => {
    const fn = new LocalHashEmbeddingFunction();
    const v1 = await fn.generate(["hello"]);
    const v2 = await fn.generate(["world"]);
    expect(v1[0]).not.toEqual(v2[0]);
  });

  test("vectors are normalized (unit length)", async () => {
    const fn = new LocalHashEmbeddingFunction();
    const vectors = await fn.generate(["test content for normalization"]);
    const v = vectors[0]!;
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  test("empty string produces zero vector (not normalized)", async () => {
    const fn = new LocalHashEmbeddingFunction();
    const vectors = await fn.generate([""]);
    const v = vectors[0]!;
    // All zeros since no input characters to hash
    expect(v.every((x) => x === 0)).toBe(true);
  });

  test("handles long text", async () => {
    const fn = new LocalHashEmbeddingFunction();
    const longText = "x".repeat(10000);
    const vectors = await fn.generate([longText]);
    expect(vectors[0]).toHaveLength(384);
    const norm = Math.sqrt(vectors[0]!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  test("handles unicode text", async () => {
    const fn = new LocalHashEmbeddingFunction();
    const vectors = await fn.generate(["中文测试 🚀 émojis"]);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(384);
  });

  test("produces different vectors for unicode vs ascii", async () => {
    const fn = new LocalHashEmbeddingFunction();
    const v1 = await fn.generate(["test"]);
    const v2 = await fn.generate(["测试"]);
    expect(v1[0]).not.toEqual(v2[0]);
  });

  test("getConfig returns correct dimension", async () => {
    const fn = new LocalHashEmbeddingFunction();
    const config = fn.getConfig();
    expect(config).toEqual({ dimension: 384 });
  });
});
