/**
 * Internal integration tests that call repository methods directly,
 * avoiding the seekdb embedded-mode segfault-on-exit bug that breaks
 * CLI subprocess tests for SQL-only tables (timeline, tags, links, raw).
 *
 * NOTE: seekdb embedded mode has process-level singleton state, so all
 * tests must share a single database. Data is cleaned between tests.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSettings } from "../settings";
import { BrainDb } from "../db/client";
import { BrainRepository } from "../repositories/brain-repo";

let sharedRepo: BrainRepository;
let sharedDb: BrainDb;
let testCounter = 0;

/** Unique slug prefix to isolate tests that can't use DELETE cleanup. */
function uid(): string {
  return `t${++testCounter}`;
}

async function clearAll() {
  await sharedDb.client.execute("DELETE FROM timeline_entries");
  await sharedDb.client.execute("DELETE FROM page_tags");
  await sharedDb.client.execute("DELETE FROM links");
  await sharedDb.client.execute("DELETE FROM raw_data");
  await sharedDb.client.execute("DELETE FROM pages");
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "ebrain-internal-"));
  const dbPath = join(dir, "test.db");
  const settings = await loadSettings();
  sharedDb = await BrainDb.connect(dbPath, settings);
  sharedRepo = new BrainRepository(sharedDb);
});

afterAll(async () => {
  try { await sharedDb.close(); } catch { /* best effort */ }
});

beforeEach(async () => {
  await clearAll();
});

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

describe("ebrain timeline (internal)", () => {
  test("adds and lists timeline entries", async () => {
    const id = uid();
    await sharedRepo.timelineAdd({
      pageSlug: `${id}-page`,
      date: "2025-01-15",
      source: "manual",
      summary: "First event",
      detail: "",
    });
    await sharedRepo.timelineAdd({
      pageSlug: `${id}-page`,
      date: "2025-03-20",
      source: "manual",
      summary: "Second event",
      detail: "",
    });

    const entries = await sharedRepo.timeline(`${id}-page`);
    expect(entries.length).toBe(2);
    expect(entries[0].summary).toBe("Second event"); // DESC order
    expect(entries[1].summary).toBe("First event");
  });

  test("timeline list --limit", async () => {
    const id = uid();
    await sharedRepo.timelineAdd({ pageSlug: `${id}-page`, date: "2025-01-01", source: "m", summary: "A", detail: "" });
    await sharedRepo.timelineAdd({ pageSlug: `${id}-page`, date: "2025-02-01", source: "m", summary: "B", detail: "" });
    await sharedRepo.timelineAdd({ pageSlug: `${id}-page`, date: "2025-03-01", source: "m", summary: "C", detail: "" });

    const entries = await sharedRepo.timeline(`${id}-page`, 1);
    expect(entries.length).toBe(1);
    expect(entries[0].summary).toBe("C");
  });

  test("timeline global", async () => {
    const id = uid();
    await sharedRepo.timelineAdd({ pageSlug: `${id}-p1`, date: "2025-01-01", source: "m", summary: "Event 1", detail: "" });
    await sharedRepo.timelineAdd({ pageSlug: `${id}-p2`, date: "2025-03-01", source: "m", summary: "Event 2", detail: "" });

    const entries = await sharedRepo.timelineGlobal(10);
    // Note: global includes entries from ALL pages, including beforeEach cleanup
    // that may leave orphan entries. Just verify our entries are present.
    const summaries = entries.map((e) => e.summary);
    expect(summaries).toContain("Event 1");
    expect(summaries).toContain("Event 2");
    // DESC order: Event 2 (Mar) should come before Event 1 (Jan)
    const idx1 = summaries.indexOf("Event 2");
    const idx2 = summaries.indexOf("Event 1");
    expect(idx1).toBeLessThan(idx2);
  });
});

// ---------------------------------------------------------------------------
// tag
// ---------------------------------------------------------------------------

describe("ebrain tag (internal)", () => {
  test("adds and lists tags", async () => {
    const id = uid();
    await sharedRepo.tag(`${id}-page`, "alpha");
    await sharedRepo.tag(`${id}-page`, "beta");

    const tags = await sharedRepo.tags(`${id}-page`);
    expect(tags).toContain("alpha");
    expect(tags).toContain("beta");
    expect(tags.length).toBe(2);
  });

  test("tag add is idempotent", async () => {
    const id = uid();
    await sharedRepo.tag(`${id}-page`, "alpha");
    await sharedRepo.tag(`${id}-page`, "alpha");

    const tags = await sharedRepo.tags(`${id}-page`);
    expect(tags.filter((t) => t === "alpha")).toHaveLength(1);
  });

  test("tag remove deletes tag", async () => {
    const id = uid();
    await sharedRepo.tag(`${id}-page`, "to-remove");
    await sharedRepo.untag(`${id}-page`, "to-remove");

    const tags = await sharedRepo.tags(`${id}-page`);
    expect(tags).not.toContain("to-remove");
  });
});

// ---------------------------------------------------------------------------
// link
// ---------------------------------------------------------------------------

describe("ebrain link (internal)", () => {
  test("creates and reads backlinks", async () => {
    const id = uid();
    await sharedRepo.link(`${id}-from`, `${id}-to`, "references");
    await sharedRepo.link(`${id}-another`, `${id}-to`, "mentions");

    const bl = await sharedRepo.backlinks(`${id}-to`);
    expect(bl).toContain(`${id}-from`);
    expect(bl).toContain(`${id}-another`);
    expect(bl.length).toBe(2);
  });

  test("link is idempotent (ON DUPLICATE KEY UPDATE)", async () => {
    const id = uid();
    await sharedRepo.link(`${id}-a`, `${id}-b`, "first");
    await sharedRepo.link(`${id}-a`, `${id}-b`, "updated");

    const bl = await sharedRepo.backlinks(`${id}-b`);
    expect(bl).toContain(`${id}-a`);
    expect(bl.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// raw
// ---------------------------------------------------------------------------

describe("ebrain raw (internal)", () => {
  test("writes and reads raw data", async () => {
    const id = uid();
    await sharedRepo.writeRaw(`${id}-page`, "test-source", { key: "value" });

    const rows = (await sharedRepo.readRaw(`${id}-page`)) as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("test-source");
    expect(rows[0].data).toEqual({ key: "value" });
  });

  test("raw get with --source filters results", async () => {
    const id = uid();
    await sharedRepo.writeRaw(`${id}-page`, "src-a", { a: 1 });
    await sharedRepo.writeRaw(`${id}-page`, "src-b", { b: 2 });

    const rows = (await sharedRepo.readRaw(`${id}-page`, "src-a")) as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("src-a");
  });
});

// ---------------------------------------------------------------------------
// deletePage cascades
// ---------------------------------------------------------------------------

describe("ebrain deletePage (internal)", () => {
  test("deletePage removes related data", async () => {
    const id = uid();
    await sharedRepo.putPage({
      slug: `${id}-delete`,
      type: "note",
      title: "Delete Me",
      compiledTruth: "Content",
      timeline: "",
      frontmatter: {},
    });
    await sharedRepo.link(`${id}-delete`, `${id}-other`, "ref");
    await sharedRepo.tag(`${id}-delete`, "tag1");
    await sharedRepo.timelineAdd({ pageSlug: `${id}-delete`, date: "2025-01-01", source: "m", summary: "Event", detail: "" });

    // Delete
    await sharedRepo.deletePage(`${id}-delete`);

    // Verify cascade
    const page = await sharedRepo.getPage(`${id}-delete`);
    expect(page).toBeNull();
    expect(await sharedRepo.tags(`${id}-delete`)).toEqual([]);
    expect(await sharedRepo.timeline(`${id}-delete`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// entity rename / merge
// ---------------------------------------------------------------------------

describe("ebrain entity rename and merge (internal)", () => {
  test("renamePage changes slug and preserves relationships", async () => {
    const id = uid();
    await sharedRepo.putPage({
      slug: `people/${id}-jon-smith`,
      type: "person",
      title: "Jon Smith",
      compiledTruth: "Old spelling",
      timeline: "",
      frontmatter: {},
    });
    await sharedRepo.putPage({
      slug: `companies/${id}-acme`,
      type: "company",
      title: "Acme",
      compiledTruth: "Company",
      timeline: "",
      frontmatter: {},
    });
    await sharedRepo.link(`people/${id}-jon-smith`, `companies/${id}-acme`, "works_at");

    const result = await sharedRepo.renamePage(`people/${id}-jon-smith`, `${id} John Smith`);

    const renamedSlug = `people/${id}-john-smith`;
    expect(result).toEqual({ slug: renamedSlug, merged: false });
    expect(await sharedRepo.getPage(`people/${id}-jon-smith`)).toBeNull();
    const renamed = await sharedRepo.getPage(renamedSlug);
    expect(renamed?.title).toBe(`${id} John Smith`);
    expect(await sharedRepo.outgoingLinks(renamedSlug)).toEqual([
      { slug: `companies/${id}-acme`, context: "works_at" },
    ]);
  });

  test("renamePage merges into an existing entity and transfers related data", async () => {
    const id = uid();
    await sharedRepo.putPage({
      slug: `people/${id}-jon-smith`,
      type: "person",
      title: "Jon Smith",
      compiledTruth: "Old spelling facts",
      timeline: "Old timeline",
      frontmatter: {},
    });
    await sharedRepo.putPage({
      slug: `people/${id}-john-smith`,
      type: "person",
      title: `${id} John Smith`,
      compiledTruth: "Canonical facts",
      timeline: "Canonical timeline",
      frontmatter: {},
    });
    await sharedRepo.putPage({
      slug: `companies/${id}-acme`,
      type: "company",
      title: "Acme",
      compiledTruth: "Company",
      timeline: "",
      frontmatter: {},
    });
    await sharedRepo.link(`people/${id}-jon-smith`, `companies/${id}-acme`, "works_at");
    await sharedRepo.link(`people/${id}-john-smith`, `companies/${id}-acme`, "advisor");
    await sharedRepo.link(`companies/${id}-acme`, `people/${id}-jon-smith`, "mentions");
    await sharedRepo.tag(`people/${id}-jon-smith`, "alias");
    await sharedRepo.timelineAdd({ pageSlug: `people/${id}-jon-smith`, date: "2025-01-01", source: "m", summary: "Old event", detail: "" });
    await sharedRepo.writeRaw(`people/${id}-jon-smith`, "source", { old: true });

    const result = await sharedRepo.renamePage(`people/${id}-jon-smith`, `${id} John Smith`);

    const targetSlug = `people/${id}-john-smith`;
    expect(result).toEqual({ slug: targetSlug, merged: true });
    expect(await sharedRepo.getPage(`people/${id}-jon-smith`)).toBeNull();
    const target = await sharedRepo.getPage(targetSlug);
    expect(target?.compiledTruth).toContain("Canonical facts");
    expect(target?.compiledTruth).toContain("Old spelling facts");
    expect(await sharedRepo.tags(targetSlug)).toContain("alias");
    expect((await sharedRepo.timeline(targetSlug)).map((entry) => entry.summary)).toContain("Old event");
    expect((await sharedRepo.readRaw(targetSlug)) as unknown[]).toHaveLength(1);

    const outgoing = await sharedRepo.outgoingLinks(targetSlug);
    expect(outgoing).toHaveLength(1);
    const mergedLink = outgoing[0]!;
    expect(mergedLink.slug).toBe(`companies/${id}-acme`);
    expect(mergedLink.context).toContain("advisor");
    expect(mergedLink.context).toContain("works_at");
    expect(await sharedRepo.backlinks(targetSlug)).toContain(`companies/${id}-acme`);
  });

  test("mergePage deletes the source entity and transfers relationships to target", async () => {
    const id = uid();
    await sharedRepo.putPage({
      slug: `people/${id}-duplicate`,
      type: "person",
      title: "Duplicate",
      compiledTruth: "Duplicate facts",
      timeline: "",
      frontmatter: {},
    });
    await sharedRepo.putPage({
      slug: `people/${id}-canonical`,
      type: "person",
      title: "Canonical",
      compiledTruth: "Canonical facts",
      timeline: "",
      frontmatter: {},
    });
    await sharedRepo.putPage({
      slug: `companies/${id}-acme`,
      type: "company",
      title: "Acme",
      compiledTruth: "Company",
      timeline: "",
      frontmatter: {},
    });
    await sharedRepo.link(`people/${id}-duplicate`, `companies/${id}-acme`, "works_at");

    const result = await sharedRepo.mergePage(`people/${id}-duplicate`, `people/${id}-canonical`);

    expect(result).toEqual({ slug: `people/${id}-canonical`, merged: true });
    expect(await sharedRepo.getPage(`people/${id}-duplicate`)).toBeNull();
    expect(await sharedRepo.outgoingLinks(`people/${id}-canonical`)).toEqual([
      { slug: `companies/${id}-acme`, context: "works_at" },
    ]);
  });

  test("mergePage rolls back if reference migration fails", async () => {
    const id = uid();
    await sharedRepo.putPage({
      slug: `people/${id}-duplicate`,
      type: "person",
      title: "Duplicate",
      compiledTruth: "Duplicate facts",
      timeline: "",
      frontmatter: {},
    });
    await sharedRepo.putPage({
      slug: `people/${id}-canonical`,
      type: "person",
      title: "Canonical",
      compiledTruth: "Canonical facts",
      timeline: "",
      frontmatter: {},
    });
    const originalExecute = sharedDb.client.execute.bind(sharedDb.client);
    sharedDb.client.execute = (async (sql: string, params?: unknown[]) => {
      if (sql.includes("UPDATE raw_data")) {
        throw new Error("forced raw_data migration failure");
      }
      return originalExecute(sql, params);
    }) as typeof sharedDb.client.execute;

    try {
      await expect(sharedRepo.mergePage(`people/${id}-duplicate`, `people/${id}-canonical`)).rejects.toThrow();

      expect(await sharedRepo.getPage(`people/${id}-duplicate`)).not.toBeNull();
      const target = await sharedRepo.getPage(`people/${id}-canonical`);
      expect(target?.compiledTruth).toBe("Canonical facts");
    } finally {
      sharedDb.client.execute = originalExecute as typeof sharedDb.client.execute;
    }
  });
});
