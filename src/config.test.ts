import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DB_NAME,
  MAX_SLUG_LENGTH,
  PAGES_COLLECTION,
  inferTypeFromSlug,
  normalizeLongSlug,
  nowIso,
  slugToTitle,
  slugify,
} from "./config";

describe("constants", () => {
  test("DEFAULT_DB_NAME", () => {
    expect(DEFAULT_DB_NAME).toBe("ebrain");
  });

  test("PAGES_COLLECTION", () => {
    expect(PAGES_COLLECTION).toBe("ebrain_pages");
  });

  test("MAX_SLUG_LENGTH", () => {
    expect(MAX_SLUG_LENGTH).toBe(100);
  });
});

describe("nowIso", () => {
  test("returns valid ISO 8601 string", () => {
    const result = nowIso();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("creates a Date that is parseable", () => {
    const result = nowIso();
    const date = new Date(result);
    expect(date.getTime()).not.toBeNaN();
  });
});

describe("slugToTitle", () => {
  test("converts kebab-case to title case", () => {
    expect(slugToTitle("my-awesome-page")).toBe("My Awesome Page");
  });

  test("uses last segment for nested slugs", () => {
    expect(slugToTitle("docs/api-reference")).toBe("Api Reference");
  });

  test("handles single segment", () => {
    expect(slugToTitle("hello-world")).toBe("Hello World");
  });

  test("handles empty string", () => {
    expect(slugToTitle("")).toBe("");
  });
});

describe("inferTypeFromSlug", () => {
  test("extracts first segment as type", () => {
    expect(inferTypeFromSlug("docs/api")).toBe("docs");
    expect(inferTypeFromSlug("people/john")).toBe("people");
  });

  test("returns the slug itself for top-level (no /)", () => {
    expect(inferTypeFromSlug("notes")).toBe("notes");
  });
});

describe("slugify", () => {
  test("converts Chinese to pinyin", () => {
    expect(slugify("中文测试")).toBe("zhong_wen_ce_shi");
    expect(slugify("我的学习笔记")).toBe("wo_de_xue_xi_bi_ji");
  });

  test("keeps English words together", () => {
    expect(slugify("Hello 世界 2024")).toBe("hello_shi_jie_2024");
    expect(slugify("API 参考文档")).toBe("api_can_kao_wen_dang");
  });

  test("handles mixed content with special chars", () => {
    expect(slugify("My File (v1.0) [Draft]")).toBe("my_file_v1_0_draft");
    expect(slugify("docs/API-参考文档")).toBe("docs_api_can_kao_wen_dang");
  });

  test("handles path segments with slashes", () => {
    expect(slugify("docs/API参考文档/v2")).toBe(
      "docs_api_can_kao_wen_dang_v2",
    );
  });

  test("truncates to max length", () => {
    const longInput = "这是一个非常长的中文标题".repeat(10);
    const result = slugify(longInput);
    expect(result.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(result).not.toMatch(/_$/);
  });

  test("returns 'untitled' for empty input", () => {
    expect(slugify("")).toBe("untitled");
    expect(slugify("   ")).toBe("untitled");
    expect(slugify("!!!")).toBe("untitled");
  });
});

describe("normalizeLongSlug", () => {
  test("leaves short slugs unchanged", () => {
    expect(normalizeLongSlug("docs/api")).toBe("docs/api");
    expect(normalizeLongSlug("people/john-doe")).toBe("people/john-doe");
    expect(normalizeLongSlug("short")).toBe("short");
  });

  test("normalizes long slugs", () => {
    const longInput = "这是一个非常长的中文标题".repeat(10);
    expect(longInput.length).toBeGreaterThan(MAX_SLUG_LENGTH);
    const result = normalizeLongSlug(longInput);
    expect(result.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(result).toMatch(/^[a-z0-9_]+$/);
  });

  test("threshold is exactly MAX_SLUG_LENGTH", () => {
    const exactLen = "a".repeat(MAX_SLUG_LENGTH);
    expect(normalizeLongSlug(exactLen)).toBe(exactLen);

    const overLen = "a".repeat(MAX_SLUG_LENGTH + 1);
    expect(normalizeLongSlug(overLen)).not.toBe(overLen);
  });
});
