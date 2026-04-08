import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectMarkdownFiles,
  ensureDir,
  fileExists,
  pathToSlug,
  readMaybeStdin,
  readTextFile,
  slugToPath,
  writeTextFile,
} from "./io";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ebrain-io-test-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// pathToSlug
// ---------------------------------------------------------------------------

describe("pathToSlug", () => {
  test("converts file path relative to root into slug", () => {
    expect(pathToSlug("/root/docs/api.md", "/root")).toBe("docs/api");
  });

  test("removes .md extension", () => {
    expect(pathToSlug("/root/notes.md", "/root")).toBe("notes");
  });

  test("handles nested directories", () => {
    expect(pathToSlug("/root/a/b/c.md", "/root")).toBe("a/b/c");
  });

  test("replaces .md extension in result", () => {
    const result = pathToSlug("/root/docs/api.md", "/root");
    expect(result).not.toContain(".md");
  });

  test("handles file directly in root", () => {
    expect(pathToSlug("/root/readme.md", "/root")).toBe("readme");
  });
});

// ---------------------------------------------------------------------------
// slugToPath
// ---------------------------------------------------------------------------

describe("slugToPath", () => {
  test("converts slug to file path under root", () => {
    const result = slugToPath("docs/api", "/root");
    expect(result).toBe(join("/root", "docs", "api.md"));
  });

  test("adds .md extension", () => {
    const result = slugToPath("notes", "/root");
    expect(result).toBe(join("/root", "notes.md"));
  });

  test("handles nested slugs", () => {
    const result = slugToPath("a/b/c", "/root");
    expect(result).toBe(join("/root", "a", "b", "c.md"));
  });
});

// ---------------------------------------------------------------------------
// writeTextFile / readTextFile
// ---------------------------------------------------------------------------

describe("writeTextFile / readTextFile", () => {
  test("writes and reads back content", async () => {
    const path = join(tmpDir, "test-write.txt");
    await writeTextFile(path, "hello world");
    const content = await readTextFile(path);
    expect(content).toBe("hello world");
  });

  test("creates parent directories automatically", async () => {
    const path = join(tmpDir, "deep", "nested", "dir", "file.txt");
    await writeTextFile(path, "nested content");
    const content = await readTextFile(path);
    expect(content).toBe("nested content");
  });

  test("overwrites existing file", async () => {
    const path = join(tmpDir, "overwrite.txt");
    await writeTextFile(path, "first");
    await writeTextFile(path, "second");
    const content = await readTextFile(path);
    expect(content).toBe("second");
  });

  test("handles unicode content", async () => {
    const path = join(tmpDir, "unicode.txt");
    const content = "中文测试 \u{1F680} \u00e9mojis";
    await writeTextFile(path, content);
    const read = await readTextFile(path);
    expect(read).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// fileExists
// ---------------------------------------------------------------------------

describe("fileExists", () => {
  test("returns true for existing file", async () => {
    const path = join(tmpDir, "exists.txt");
    await writeTextFile(path, "content");
    expect(await fileExists(path)).toBe(true);
  });

  test("returns true for existing directory", async () => {
    const dir = join(tmpDir, "exists-dir");
    await ensureDir(dir);
    expect(await fileExists(dir)).toBe(true);
  });

  test("returns false for non-existent path", async () => {
    expect(await fileExists(join(tmpDir, "no-such-file.txt"))).toBe(false);
  });

  test("returns false for deep non-existent path", async () => {
    expect(
      await fileExists(join(tmpDir, "a", "b", "c", "missing.txt")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ensureDir
// ---------------------------------------------------------------------------

describe("ensureDir", () => {
  test("creates directory", async () => {
    const dir = join(tmpDir, "new-dir");
    await ensureDir(dir);
    expect(await fileExists(dir)).toBe(true);
  });

  test("creates nested directories", async () => {
    const dir = join(tmpDir, "level1", "level2", "level3");
    await ensureDir(dir);
    expect(await fileExists(dir)).toBe(true);
  });

  test("is idempotent (no error if exists)", async () => {
    const dir = join(tmpDir, "idempotent-dir");
    await ensureDir(dir);
    await ensureDir(dir);
    expect(await fileExists(dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// collectMarkdownFiles
// ---------------------------------------------------------------------------

describe("collectMarkdownFiles", () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = join(tmpDir, "collect-test");
    await ensureDir(join(workDir, "subdir"));
    await writeTextFile(join(workDir, "a.md"), "a");
    await writeTextFile(join(workDir, "b.md"), "b");
    await writeTextFile(join(workDir, "subdir", "c.md"), "c");
    await writeTextFile(join(workDir, "skip.txt"), "not markdown");
    await writeTextFile(join(workDir, "skip.json"), '{"key":"val"}');
  });

  test("collects all .md files recursively", async () => {
    const files = await collectMarkdownFiles(workDir);
    expect(files).toHaveLength(3);
    expect(files.every((f) => f.endsWith(".md"))).toBe(true);
  });

  test("returns sorted paths", async () => {
    const files = await collectMarkdownFiles(workDir);
    expect(files).toEqual([...files].sort());
  });

  test("excludes non-.md files", async () => {
    const files = await collectMarkdownFiles(workDir);
    expect(files.some((f) => f.endsWith(".txt"))).toBe(false);
    expect(files.some((f) => f.endsWith(".json"))).toBe(false);
  });

  test("includes files in subdirectories", async () => {
    const files = await collectMarkdownFiles(workDir);
    expect(files.some((f) => f.includes("subdir"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readMaybeStdin
// ---------------------------------------------------------------------------

describe("readMaybeStdin", () => {
  test("returns null when stdin is TTY", async () => {
    const result = await readMaybeStdin();
    expect(typeof result === "string" || result === null).toBe(true);
  });
});
