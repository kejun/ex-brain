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
