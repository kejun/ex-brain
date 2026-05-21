import { pinyin } from "pinyin-pro";

export const DEFAULT_DB_NAME = "ebrain";
export const PAGES_COLLECTION = "ebrain_pages";
export const MAX_SLUG_LENGTH = 100;

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugToTitle(slug: string): string {
  const base = slug.split("/").at(-1) ?? slug;
  return base
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Infer page type from slug path.
 * - Slugs with a path prefix (e.g. "notes/my-post") → use the prefix as type
 * - Flat slugs without "/" (e.g. "26_05_20_xxx" or "rm_hui_yi_ji_yao_0325") → default to "article"
 * - Fallback to "other" if empty
 */
export function inferTypeFromSlug(slug: string): string {
  const segments = slug.split("/");
  if (segments.length > 1 && segments[0]) {
    return segments[0];
  }
  // Flat slug — treat as a generic article/note
  return "article";
}

/**
 * 将包含中文、空格、特殊字符的原始 slug 转换为
 * 全英文小写 + 下划线连接的规范化格式。
 * - 中文 → 拼音（无音调），英文单词保持完整不逐字母拆分
 * - 空格/连字符/斜杠/点 → 下划线
 * - 移除非字母数字字符
 * - 截断至 MAX_SLUG_LENGTH
 */
export function slugify(input: string, maxLen = MAX_SLUG_LENGTH): string {
  // 1. 分段处理：中文字符转拼音，非中文保持原样
  let slug = "";
  let chineseBuf = "";

  function flushChinese() {
    if (chineseBuf.length > 0) {
      slug += " " + pinyin(chineseBuf, { toneType: "none", type: "string" });
      chineseBuf = "";
    }
  }

  for (const ch of input) {
    // CJK Unified Ideographs range
    if (ch >= "\u4e00" && ch <= "\u9fff") {
      chineseBuf += ch;
    } else {
      flushChinese();
      slug += ch;
    }
  }
  flushChinese();

  // 2. 转小写
  slug = slug.toLowerCase();

  // 3. 将所有非字母数字字符替换为下划线
  slug = slug.replace(/[^a-z0-9]+/g, "_");

  // 4. 合并连续下划线、去除首尾下划线
  slug = slug.replace(/_+/g, "_").replace(/^_|_$/g, "");

  // 5. 截断（确保不在下划线中间截断）
  if (slug.length > maxLen) {
    slug = slug.slice(0, maxLen).replace(/_+$/, "");
  }

  return slug || "untitled";
}

/**
 * 仅当 slug 超过阈值时才进行规范化，避免改动已经合理的短 slug。
 */
export function normalizeLongSlug(slug: string): string {
  if (slug.length > MAX_SLUG_LENGTH) {
    return slugify(slug);
  }
  return slug;
}
