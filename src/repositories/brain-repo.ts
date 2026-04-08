import { nowIso } from "../config";
import type {
  BrainStats,
  PageRecord,
  PutPageInput,
  SearchHit,
  TimelineEntry,
} from "../types";
import { BrainDb } from "../db/client";

type SqlRow = Record<string, unknown>;

function one<T>(rows: SqlRow[] | null): T | null {
  if (!rows || rows.length === 0) {
    return null;
  }
  return rows[0] as T;
}

function many<T>(rows: SqlRow[] | null): T[] {
  return (rows ?? []) as T[];
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class BrainRepository {
  constructor(private readonly db: BrainDb) {}

  async init(): Promise<void> {
    // Schema is auto-created when connecting.
  }

  async getPage(slug: string): Promise<PageRecord | null> {
    const rows = await this.db.client.execute(
      `SELECT slug, type, title, compiled_truth, timeline, frontmatter, created_at, updated_at
       FROM pages WHERE slug = ?`,
      [slug],
    );
    const row = one<{
      slug: string;
      type: string;
      title: string;
      compiled_truth: string;
      timeline: string;
      frontmatter: string;
      created_at: string;
      updated_at: string;
    }>(rows);
    if (!row) {
      return null;
    }
    return {
      slug: row.slug,
      type: row.type,
      title: row.title,
      compiledTruth: row.compiled_truth,
      timeline: row.timeline,
      frontmatter: parseFrontmatter(row.frontmatter),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async putPage(input: PutPageInput, skipEmbed = false): Promise<PageRecord> {
    const now = nowIso();
    const existing = await this.getPage(input.slug);
    const createdAt = existing?.createdAt ?? now;
    const frontmatter = JSON.stringify(input.frontmatter ?? {});
    const timeline = input.timeline ?? existing?.timeline ?? "";
    await this.db.client.execute(
      `INSERT INTO pages (slug, type, title, compiled_truth, timeline, frontmatter, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         type = VALUES(type),
         title = VALUES(title),
         compiled_truth = VALUES(compiled_truth),
         timeline = VALUES(timeline),
         frontmatter = VALUES(frontmatter),
         updated_at = VALUES(updated_at)`,
      [
        input.slug,
        input.type,
        input.title,
        input.compiledTruth,
        timeline,
        frontmatter,
        createdAt,
        now,
      ],
    );
    if (!skipEmbed) {
      await this.syncPageToSearch(input.slug);
    }
    return (await this.getPage(input.slug)) as PageRecord;
  }

  async listPages(filters: {
    type?: string;
    tag?: string;
    limit?: number;
  }): Promise<PageRecord[]> {
    const limit = filters.limit ?? 50;
    const params: unknown[] = [];
    let sql = `SELECT p.slug, p.type, p.title, p.compiled_truth, p.timeline, p.frontmatter, p.created_at, p.updated_at
               FROM pages p`;
    if (filters.tag) {
      sql += " INNER JOIN page_tags t ON p.slug = t.page_slug";
    }
    sql += " WHERE 1=1";
    if (filters.type) {
      sql += " AND p.type = ?";
      params.push(filters.type);
    }
    if (filters.tag) {
      sql += " AND t.tag = ?";
      params.push(filters.tag);
    }
    sql += " ORDER BY p.updated_at DESC LIMIT ?";
    params.push(limit);
    const rows = many<{
      slug: string;
      type: string;
      title: string;
      compiled_truth: string;
      timeline: string;
      frontmatter: string;
      created_at: string;
      updated_at: string;
    }>(await this.db.client.execute(sql, params));

    return rows.map((row) => ({
      slug: row.slug,
      type: row.type,
      title: row.title,
      compiledTruth: row.compiled_truth,
      timeline: row.timeline,
      frontmatter: parseFrontmatter(row.frontmatter),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async stats(): Promise<BrainStats> {
    const rows = await this.db.client.execute(
      `SELECT
        (SELECT COUNT(*) FROM pages) AS pages,
        (SELECT COUNT(*) FROM links) AS links,
        (SELECT COUNT(*) FROM page_tags) AS tags,
        (SELECT COUNT(*) FROM timeline_entries) AS timeline_entries,
        (SELECT COUNT(*) FROM raw_data) AS raw_rows`,
    );
    const row = one<{
      pages: number;
      links: number;
      tags: number;
      timeline_entries: number;
      raw_rows: number;
    }>(rows);
    return {
      pages: Number(row?.pages ?? 0),
      links: Number(row?.links ?? 0),
      tags: Number(row?.tags ?? 0),
      timelineEntries: Number(row?.timeline_entries ?? 0),
      rawRows: Number(row?.raw_rows ?? 0),
    };
  }

  async search(query: string, limit = 10, type?: string): Promise<SearchHit[]> {
    const where = type ? ({ type } as Record<string, unknown>) : undefined;
    const result = await this.db.pagesCollection.hybridSearch({
      query: { whereDocument: { $contains: query }, where },
      nResults: limit,
      include: ["documents", "metadatas", "distances"],
    });
    const ids = result.ids[0] ?? [];
    const metadatas = result.metadatas?.[0] ?? [];
    const docs = result.documents?.[0] ?? [];
    const distances = result.distances?.[0] ?? [];
    const hits: SearchHit[] = [];
    for (let i = 0; i < ids.length; i += 1) {
      const slug = ids[i];
      if (!slug) continue;
      const md = (metadatas[i] ?? {}) as Record<string, unknown>;
      const distance = typeof distances[i] === "number" ? distances[i] : 1;
      const score = 1 / (1 + distance);
      hits.push({
        slug,
        title: String(md.title ?? slug),
        type: String(md.type ?? "other"),
        score,
        excerpt: String(docs[i] ?? "").slice(0, 220),
        updatedAt: String(md.updatedAt ?? ""),
      });
    }
    return hits;
  }

  async query(question: string, limit = 10): Promise<SearchHit[]> {
    const result = await this.db.pagesCollection.query({
      queryTexts: question,
      nResults: limit,
      include: ["documents", "metadatas", "distances"],
    });
    const ids = result.ids[0] ?? [];
    const metadatas = result.metadatas?.[0] ?? [];
    const docs = result.documents?.[0] ?? [];
    const distances = result.distances?.[0] ?? [];
    const hits: SearchHit[] = [];
    for (let i = 0; i < ids.length; i += 1) {
      const slug = ids[i];
      if (!slug) continue;
      const md = (metadatas[i] ?? {}) as Record<string, unknown>;
      const distance = typeof distances[i] === "number" ? distances[i] : 1;
      const vectorScore = 1 / (1 + distance);
      const freshnessBoost = this.recentBoost(String(md.updatedAt ?? ""));
      const typeBoost = String(md.type ?? "") === "person" ? 0.05 : 0;
      const score = vectorScore * 0.85 + freshnessBoost + typeBoost;
      hits.push({
        slug,
        title: String(md.title ?? slug),
        type: String(md.type ?? "other"),
        score,
        excerpt: String(docs[i] ?? "").slice(0, 220),
        updatedAt: String(md.updatedAt ?? ""),
      });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits;
  }

  private recentBoost(updatedAt: string): number {
    if (!updatedAt) return 0;
    const age = Date.now() - new Date(updatedAt).getTime();
    const days = age / (1000 * 60 * 60 * 24);
    return days <= 30 ? 0.1 : 0;
  }

  async syncPageToSearch(slug: string): Promise<void> {
    const page = await this.getPage(slug);
    if (!page) return;
    const doc = `${page.title}\n\n${page.compiledTruth}\n\n${page.timeline}`;
    const meta = {
      slug: page.slug,
      title: page.title,
      type: page.type,
      updatedAt: page.updatedAt,
    };
    await this.db.pagesCollection.upsert({
      ids: [page.slug],
      documents: [doc],
      metadatas: [meta],
    });
  }

  /**
   * Batch sync multiple pages to search index.
   * More efficient than calling syncPageToSearch for each page.
   */
  async syncPagesToSearch(slugs: string[]): Promise<void> {
    const pages = await Promise.all(slugs.map(s => this.getPage(s)));
    const validPages = pages.filter((p): p is PageRecord => p !== null);
    if (validPages.length === 0) return;
    
    const docs = validPages.map(p => `${p.title}\n\n${p.compiledTruth}\n\n${p.timeline}`);
    const metas = validPages.map(p => ({
      slug: p.slug,
      title: p.title,
      type: p.type,
      updatedAt: p.updatedAt,
    }));
    
    await this.db.pagesCollection.upsert({
      ids: validPages.map(p => p.slug),
      documents: docs,
      metadatas: metas,
    });
  }

  async embedAll(): Promise<number> {
    const pages = await this.listPages({ limit: 100000 });
    for (const page of pages) {
      await this.syncPageToSearch(page.slug);
    }
    return pages.length;
  }

  async link(fromSlug: string, toSlug: string, context: string): Promise<void> {
    await this.db.client.execute(
      `INSERT INTO links (from_slug, to_slug, context, created_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE context = VALUES(context)`,
      [fromSlug, toSlug, context, nowIso()],
    );
  }

  async timeline(slug: string, limit = 50): Promise<TimelineEntry[]> {
    const rows = many<{
      id: number;
      page_slug: string;
      date: string;
      source: string;
      summary: string;
      detail: string;
    }>(
      await this.db.client.execute(
        `SELECT id, page_slug, date, source, summary, detail
         FROM timeline_entries
         WHERE page_slug = ?
         ORDER BY date DESC, id DESC
         LIMIT ?`,
        [slug, limit],
      ),
    );
    return rows.map((row) => ({
      id: row.id,
      pageSlug: row.page_slug,
      date: row.date,
      source: row.source,
      summary: row.summary,
      detail: row.detail,
    }));
  }

  async timelineAdd(entry: TimelineEntry): Promise<void> {
    await this.db.client.execute(
      `INSERT INTO timeline_entries (page_slug, date, source, summary, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        entry.pageSlug,
        entry.date,
        entry.source,
        entry.summary,
        entry.detail,
        nowIso(),
      ],
    );
  }

  async tags(slug: string): Promise<string[]> {
    const rows = many<{ tag: string }>(
      await this.db.client.execute(
        "SELECT tag FROM page_tags WHERE page_slug = ? ORDER BY tag ASC",
        [slug],
      ),
    );
    return rows.map((row) => row.tag);
  }

  async tag(slug: string, tag: string): Promise<void> {
    await this.db.client.execute(
      `INSERT INTO page_tags (page_slug, tag, created_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE tag = VALUES(tag)`,
      [slug, tag, nowIso()],
    );
  }

  async untag(slug: string, tag: string): Promise<void> {
    await this.db.client.execute(
      "DELETE FROM page_tags WHERE page_slug = ? AND tag = ?",
      [slug, tag],
    );
  }

  async readRaw(slug: string, source?: string): Promise<unknown[]> {
    const params: unknown[] = [slug];
    let sql =
      "SELECT source, data, fetched_at FROM raw_data WHERE page_slug = ?";
    if (source) {
      sql += " AND source = ?";
      params.push(source);
    }
    sql += " ORDER BY fetched_at DESC";
    const rows = many<{ source: string; data: string; fetched_at: string }>(
      await this.db.client.execute(sql, params),
    );
    return rows.map((row) => ({
      source: row.source,
      fetchedAt: row.fetched_at,
      data: safeJson(row.data),
    }));
  }

  async writeRaw(slug: string, source: string, data: unknown): Promise<void> {
    await this.db.client.execute(
      `INSERT INTO raw_data (page_slug, source, data, fetched_at)
       VALUES (?, ?, ?, ?)`,
      [slug, source, JSON.stringify(data), nowIso()],
    );
  }

  async backlinks(slug: string): Promise<string[]> {
    const rows = many<{ from_slug: string }>(
      await this.db.client.execute(
        "SELECT from_slug FROM links WHERE to_slug = ? ORDER BY from_slug ASC",
        [slug],
      ),
    );
    return rows.map((row) => row.from_slug);
  }

  async allSlugs(): Promise<string[]> {
    const rows = many<{ slug: string }>(
      await this.db.client.execute("SELECT slug FROM pages ORDER BY slug ASC"),
    );
    return rows.map((row) => row.slug);
  }

  async deletePage(slug: string): Promise<void> {
    await this.db.client.execute("DELETE FROM pages WHERE slug = ?", [slug]);
    // Best-effort cleanup of related data (ignore errors for missing rows)
    await this.db.client.execute("DELETE FROM links WHERE from_slug = ? OR to_slug = ?", [slug, slug]);
    await this.db.client.execute("DELETE FROM page_tags WHERE page_slug = ?", [slug]);
    await this.db.client.execute("DELETE FROM timeline_entries WHERE page_slug = ?", [slug]);
    await this.db.client.execute("DELETE FROM raw_data WHERE page_slug = ?", [slug]);
  }

  /**
   * Resolve an entity reference to an existing page slug if possible.
   * Logic:
   * 1. Check if generated slug exists.
   * 2. Semantic search for name match (high confidence).
   * 3. Otherwise return the candidate slug.
   */
  async findSimilarSlug(candidateSlug: string, entityName: string): Promise<string> {
    // 1. Check exact slug match
    if (await this.getPage(candidateSlug)) {
      return candidateSlug;
    }

    // 2. Semantic search for title match
    const hits = await this.search(entityName, 1);
    if (hits.length > 0) {
      const best = hits[0]!;
      // Score threshold for hybrid search: 0.75 is a safe bet for exact/near-exact title match
      if (best.score > 0.75) {
        return best.slug;
      }
    }

    // 3. Return candidate
    return candidateSlug;
  }

  /**
   * Ensure an entity page exists. If not, create it with the given context.
   * If exists, append new fact (deduped by exact sentence match).
   * @returns true if page was created, false if already existed
   */
  async ensureEntityPage(
    slug: string,
    type: string,
    title: string,
    relation: string,
    context: string,
    sourceSlug: string,
  ): Promise<boolean> {
    const existing = await this.getPage(slug);
    const newFact = `- **${relation}** [${title}](${slug}): ${context.trim()} (Source: ${sourceSlug})`;

    if (!existing) {
      await this.putPage({
        slug,
        type,
        title,
        compiledTruth: `## Facts\n\n${newFact}`,
        timeline: "",
        frontmatter: { autoCreated: true },
      });
      return true;
    }

    // Check for duplicate: if the exact context sentence already exists in compiledTruth
    const trimmedContext = context.trim();
    if (existing.compiledTruth.includes(trimmedContext)) {
      return false;
    }

    // Append new fact under ## Facts header if it exists, otherwise create it
    let updatedTruth = existing.compiledTruth;
    if (!existing.compiledTruth.includes("## Facts")) {
      updatedTruth = `## Facts\n\n${existing.compiledTruth}\n\n## Facts\n\n${newFact}`;
    } else {
      // Simple append before the first "---" or at the end
      updatedTruth = existing.compiledTruth.replace(/\n---\n/, `\n${newFact}\n\n---\n`);
      if (updatedTruth === existing.compiledTruth) {
         updatedTruth += "\n" + newFact;
      }
    }

    await this.putPage({
      slug,
      type,
      title,
      compiledTruth: updatedTruth,
      timeline: existing.timeline,
      frontmatter: existing.frontmatter,
    });
    return false;
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
