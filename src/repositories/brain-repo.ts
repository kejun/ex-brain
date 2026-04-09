import { nowIso } from "../config";
import type {
  BrainStats,
  PageRecord,
  PutPageInput,
  SearchHit,
  TimelineEntry,
} from "../types";
import type { ResolvedLLM } from "../settings";
import type { CompileInput, CompileResult } from "../ai/compiler";
import type { TimelineExtractionResult } from "../ai/timeline-extractor";
import { compileTruth } from "../ai/compiler";
import { extractTimelineEvents } from "../ai/timeline-extractor";
import { BrainDb } from "../db/client";
import { DbError, wrapDbError, logDbError, DbOperation } from "../db/errors";

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
    try {
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
    } catch (error) {
      const dbError = wrapDbError(error, "getPage", { slug });
      logDbError(dbError);
      throw dbError;
    }
  }

  async putPage(input: PutPageInput, skipEmbed = false): Promise<PageRecord> {
    try {
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
    } catch (error) {
      const dbError = wrapDbError(error, "putPage", { slug: input.slug });
      logDbError(dbError);
      throw dbError;
    }
  }

  async listPages(filters: {
    type?: string;
    tag?: string;
    limit?: number;
  }): Promise<PageRecord[]> {
    try {
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
    } catch (error) {
      const dbError = wrapDbError(error, "listPages", filters);
      logDbError(dbError);
      throw dbError;
    }
  }

  async stats(): Promise<BrainStats> {
    try {
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
    } catch (error) {
      const dbError = wrapDbError(error, "stats");
      logDbError(dbError);
      throw dbError;
    }
  }

  async search(query: string, limit = 10, type?: string): Promise<SearchHit[]> {
    try {
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
    } catch (error) {
      const dbError = wrapDbError(error, "search", { query, limit, type });
      logDbError(dbError);
      throw dbError;
    }
  }

  async query(question: string, limit = 10): Promise<SearchHit[]> {
    try {
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
    } catch (error) {
      const dbError = wrapDbError(error, "query", { question, limit });
      logDbError(dbError);
      throw dbError;
    }
  }

  private recentBoost(updatedAt: string): number {
    if (!updatedAt) return 0;
    const age = Date.now() - new Date(updatedAt).getTime();
    const days = age / (1000 * 60 * 60 * 24);
    return days <= 30 ? 0.1 : 0;
  }

  async syncPageToSearch(slug: string): Promise<void> {
    try {
      const page = await this.getPage(slug);
      if (!page) return;
      const fullDoc = `${page.title}\n\n${page.compiledTruth}\n\n${page.timeline}`;
      
      // Truncate to avoid embedding API limits (most models have 8192 token limit)
      // Conservative: ~4 chars per token, so 8192 tokens ≈ 32000 chars
      // But some models count differently, use 8000 chars as safe limit
      const MAX_DOC_LENGTH = 8000;
      const doc = fullDoc.length > MAX_DOC_LENGTH 
        ? fullDoc.slice(0, MAX_DOC_LENGTH) + '\n... (truncated)'
        : fullDoc;
      
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
    } catch (error) {
      const dbError = wrapDbError(error, "syncPageToSearch", { slug });
      logDbError(dbError);
      // Don't throw - sync failure shouldn't break the main flow
      console.warn(`[BrainRepo] syncPageToSearch failed for ${slug}: ${dbError.message}`);
    }
  }

  /**
   * Batch sync multiple pages to search index.
   * More efficient than calling syncPageToSearch for each page.
   */
  async syncPagesToSearch(slugs: string[]): Promise<void> {
    try {
      const pages = await Promise.all(slugs.map(s => this.getPage(s)));
      const validPages = pages.filter((p): p is PageRecord => p !== null);
      if (validPages.length === 0) return;
      
      const MAX_DOC_LENGTH = 8000;
      const docs = validPages.map(p => {
        const fullDoc = `${p.title}\n\n${p.compiledTruth}\n\n${p.timeline}`;
        return fullDoc.length > MAX_DOC_LENGTH
          ? fullDoc.slice(0, MAX_DOC_LENGTH) + '\n... (truncated)'
          : fullDoc;
      });
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
    } catch (error) {
      const dbError = wrapDbError(error, "syncPagesToSearch", { count: slugs.length });
      logDbError(dbError);
      // Don't throw - sync failure shouldn't break the main flow
      console.warn(`[BrainRepo] syncPagesToSearch failed: ${dbError.message}`);
    }
  }

  async embedAll(): Promise<number> {
    try {
      const pages = await this.listPages({ limit: 100000 });
      if (pages.length === 0) return 0;
      // Use batch sync for significant performance improvement
      await this.syncPagesToSearch(pages.map(p => p.slug));
      return pages.length;
    } catch (error) {
      const dbError = wrapDbError(error, "embedAll");
      logDbError(dbError);
      throw dbError;
    }
  }

  async link(fromSlug: string, toSlug: string, context: string): Promise<void> {
    try {
      await this.db.client.execute(
        `INSERT INTO links (from_slug, to_slug, context, created_at)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE context = VALUES(context)`,
        [fromSlug, toSlug, context, nowIso()],
      );
    } catch (error) {
      const dbError = wrapDbError(error, "link", { fromSlug, toSlug });
      logDbError(dbError);
      throw dbError;
    }
  }

  async timeline(slug: string, limit = 50): Promise<TimelineEntry[]> {
    try {
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
    } catch (error) {
      const dbError = wrapDbError(error, "timeline", { slug, limit });
      logDbError(dbError);
      throw dbError;
    }
  }

  async timelineAdd(entry: TimelineEntry): Promise<void> {
    try {
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
    } catch (error) {
      const dbError = wrapDbError(error, "timelineAdd", { pageSlug: entry.pageSlug });
      logDbError(dbError);
      throw dbError;
    }
  }

  /**
   * Add multiple timeline entries in batch using multi-row INSERT.
   * Much more efficient than individual INSERT statements.
   */
  async timelineAddBatch(entries: TimelineEntry[]): Promise<void> {
    try {
      if (entries.length === 0) return;
      const now = nowIso();
      
      // Use multi-row INSERT for better performance
      const placeholders = entries.map(() => `(?, ?, ?, ?, ?, ?)`).join(', ');
      const values = entries.flatMap(entry => [
        entry.pageSlug,
        entry.date,
        entry.source,
        entry.summary,
        entry.detail,
        now,
      ]);
      
      await this.db.client.execute(
        `INSERT INTO timeline_entries (page_slug, date, source, summary, detail, created_at)
         VALUES ${placeholders}`,
        values,
      );
    } catch (error) {
      const dbError = wrapDbError(error, "timelineAddBatch", { count: entries.length });
      logDbError(dbError);
      throw dbError;
    }
  }

  /**
   * Get timeline entries across all pages, sorted by date.
   */
  async timelineGlobal(limit = 100): Promise<TimelineEntry[]> {
    try {
      const rows = many<{ id: number; page_slug: string; date: string; source: string; summary: string; detail: string }>(
        await this.db.client.execute(
          `SELECT id, page_slug, date, source, summary, detail
           FROM timeline_entries
           ORDER BY date DESC, id DESC
           LIMIT ?`,
          [limit],
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
    } catch (error) {
      const dbError = wrapDbError(error, "timelineGlobal", { limit });
      logDbError(dbError);
      throw dbError;
    }
  }

  /**
   * Delete a timeline entry by ID.
   */
  async timelineDelete(id: number): Promise<void> {
    try {
      await this.db.client.execute(
        "DELETE FROM timeline_entries WHERE id = ?",
        [id],
      );
    } catch (error) {
      const dbError = wrapDbError(error, "timelineDelete", { id });
      logDbError(dbError);
      throw dbError;
    }
  }

  /**
   * Update a timeline entry by ID.
   */
  async timelineUpdate(id: number, updates: Partial<TimelineEntry>): Promise<void> {
    try {
      const fields: string[] = [];
      const values: unknown[] = [];
      if (updates.date) { fields.push("date = ?"); values.push(updates.date); }
      if (updates.source) { fields.push("source = ?"); values.push(updates.source); }
      if (updates.summary) { fields.push("summary = ?"); values.push(updates.summary); }
      if (updates.detail !== undefined) { fields.push("detail = ?"); values.push(updates.detail); }
      if (fields.length === 0) return;
      values.push(id);
      await this.db.client.execute(
        `UPDATE timeline_entries SET ${fields.join(", ")} WHERE id = ?`,
        values,
      );
    } catch (error) {
      const dbError = wrapDbError(error, "timelineUpdate", { id });
      logDbError(dbError);
      throw dbError;
    }
  }

  async tags(slug: string): Promise<string[]> {
    try {
      const rows = many<{ tag: string }>(
        await this.db.client.execute(
          "SELECT tag FROM page_tags WHERE page_slug = ? ORDER BY tag ASC",
          [slug],
        ),
      );
      return rows.map((row) => row.tag);
    } catch (error) {
      const dbError = wrapDbError(error, "tags", { slug });
      logDbError(dbError);
      throw dbError;
    }
  }

  async tag(slug: string, tag: string): Promise<void> {
    try {
      await this.db.client.execute(
        `INSERT INTO page_tags (page_slug, tag, created_at)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE tag = VALUES(tag)`,
        [slug, tag, nowIso()],
      );
    } catch (error) {
      const dbError = wrapDbError(error, "tag", { slug, tag });
      logDbError(dbError);
      throw dbError;
    }
  }

  async untag(slug: string, tag: string): Promise<void> {
    try {
      await this.db.client.execute(
        "DELETE FROM page_tags WHERE page_slug = ? AND tag = ?",
        [slug, tag],
      );
    } catch (error) {
      const dbError = wrapDbError(error, "untag", { slug, tag });
      logDbError(dbError);
      throw dbError;
    }
  }

  async readRaw(slug: string, source?: string): Promise<unknown[]> {
    try {
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
    } catch (error) {
      const dbError = wrapDbError(error, "readRaw", { slug, source });
      logDbError(dbError);
      throw dbError;
    }
  }

  async writeRaw(slug: string, source: string, data: unknown): Promise<void> {
    try {
      await this.db.client.execute(
        `INSERT INTO raw_data (page_slug, source, data, fetched_at)
         VALUES (?, ?, ?, ?)`,
        [slug, source, JSON.stringify(data), nowIso()],
      );
    } catch (error) {
      const dbError = wrapDbError(error, "writeRaw", { slug, source });
      logDbError(dbError);
      throw dbError;
    }
  }

  async backlinks(slug: string): Promise<string[]> {
    try {
      const rows = many<{ from_slug: string }>(
        await this.db.client.execute(
          "SELECT from_slug FROM links WHERE to_slug = ? ORDER BY from_slug ASC",
          [slug],
        ),
      );
      return rows.map((row) => row.from_slug);
    } catch (error) {
      const dbError = wrapDbError(error, "backlinks", { slug });
      logDbError(dbError);
      throw dbError;
    }
  }

  async allSlugs(): Promise<string[]> {
    try {
      const rows = many<{ slug: string }>(
        await this.db.client.execute("SELECT slug FROM pages ORDER BY slug ASC"),
      );
      return rows.map((row) => row.slug);
    } catch (error) {
      const dbError = wrapDbError(error, "allSlugs");
      logDbError(dbError);
      throw dbError;
    }
  }

  async deletePage(slug: string): Promise<void> {
    try {
      await this.db.client.execute("DELETE FROM pages WHERE slug = ?", [slug]);
      // Best-effort cleanup of related data (ignore errors for missing rows)
      await this.db.client.execute("DELETE FROM links WHERE from_slug = ? OR to_slug = ?", [slug, slug]);
      await this.db.client.execute("DELETE FROM page_tags WHERE page_slug = ?", [slug]);
      await this.db.client.execute("DELETE FROM timeline_entries WHERE page_slug = ?", [slug]);
      await this.db.client.execute("DELETE FROM raw_data WHERE page_slug = ?", [slug]);
    } catch (error) {
      const dbError = wrapDbError(error, "deletePage", { slug });
      logDbError(dbError);
      throw dbError;
    }
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

    // 2. Semantic search for title match - skip if no embeddings available
    // This is important for import speed: avoid slow search during batch import
    try {
      const hits = await this.search(entityName, 1);
      if (hits.length > 0) {
        const best = hits[0]!;
        // Higher threshold to avoid false matches during import
        if (best.score > 0.9) {
          return best.slug;
        }
      }
    } catch {
      // Search may fail during batch import, ignore and return candidate
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

  // ---------------------------------------------------------------------------
  // Smart Compilation & Timeline Integration
  // ---------------------------------------------------------------------------

  /**
   * Compile new information into a page's compiled truth.
   * This is the core "brain" function that:
   * 1. Analyzes new information
   * 2. Updates/replaces/appends to compiled truth intelligently
   * 3. Extracts timeline entries
   * 4. Maintains source attribution
   *
   * @param slug Page slug to compile into
   * @param newInfo New information to process
   * @param source Source of the information
   * @param date Date of the information
   * @param llm LLM configuration for semantic analysis
   * @returns Compile result with changes made
   */
  async compilePage(
    slug: string,
    newInfo: string,
    source: string,
    date: string,
    llm: ResolvedLLM,
  ): Promise<CompileResult> {
    const page = await this.getPage(slug);
    if (!page) {
      // Create new page if doesn't exist
      await this.putPage({
        slug,
        type: "other",
        title: slug.split("/").pop() ?? slug,
        compiledTruth: newInfo,
        frontmatter: { source, date, autoCreated: true },
      });
      return {
        compiledTruth: newInfo,
        changed: true,
        changeType: "append",
        changeSummary: "Created new page",
        timelineEntries: [],
        confidence: 0.8,
      };
    }

    const timeline = await this.timeline(slug, 20);
    const input: CompileInput = {
      currentTruth: page.compiledTruth,
      timeline,
      newInfo,
      source,
      date,
      pageContext: {
        slug: page.slug,
        type: page.type,
        title: page.title,
      },
    };

    const result = await compileTruth(input, llm);

    // Apply changes if any
    if (result.changed) {
      await this.putPage({
        slug: page.slug,
        type: page.type,
        title: page.title,
        compiledTruth: result.compiledTruth,
        timeline: page.timeline,
        frontmatter: page.frontmatter,
      });

      // Add timeline entries
      if (result.timelineEntries.length > 0) {
        await this.timelineAddBatch(result.timelineEntries);
      }

      // Sync to search index
      await this.syncPageToSearch(slug);
    }

    return result;
  }

  /**
   * Extract and add timeline entries from content.
   * Uses LLM for semantic extraction, falls back to regex.
   *
   * @param slug Page slug
   * @param content Content to extract timeline from
   * @param source Source identifier
   * @param defaultDate Default date for entries without explicit dates
   * @param llm LLM configuration
   * @returns Extraction result with entries added
   */
  async extractAndAddTimeline(
    slug: string,
    content: string,
    source: string,
    defaultDate: string,
    llm: ResolvedLLM,
  ): Promise<TimelineExtractionResult> {
    const result = await extractTimelineEvents(
      { content, source, defaultDate, pageSlug: slug },
      llm,
    );

    if (result.entries.length > 0) {
      await this.timelineAddBatch(result.entries);
    }

    return result;
  }

  /**
   * Full ingestion pipeline:
   * 1. Create/update page with content
   * 2. Compile truth intelligently
   * 3. Extract timeline events
   * 4. Extract entity links
   * 5. Sync to search
   *
   * @param slug Page slug
   * @param content Full content
   * @param source Source identifier
   * @param type Page type
   * @param llm LLM configuration
   * @returns Full ingestion result
   */
  async ingestContent(
    slug: string,
    content: string,
    source: string,
    type: string,
    llm: ResolvedLLM,
  ): Promise<{
    page: PageRecord;
    compileResult: CompileResult;
    timelineResult: TimelineExtractionResult;
  }> {
    const now = nowIso();
    const date = now.slice(0, 10);

    // Step 1: Compile truth (this creates/updates page)
    const compileResult = await this.compilePage(slug, content, source, date, llm);
    const page = await this.getPage(slug) as PageRecord;

    // Step 2: Extract timeline events
    const timelineResult = await this.extractAndAddTimeline(slug, content, source, date, llm);

    // Step 3: Update page type if provided
    if (type && page.type !== type) {
      await this.putPage({
        slug: page.slug,
        type,
        title: page.title,
        compiledTruth: page.compiledTruth,
        timeline: page.timeline,
        frontmatter: { ...page.frontmatter, source, sourceType: type },
      });
    }

    return { page, compileResult, timelineResult };
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
