import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrainDb } from "../db/client";
import { BrainRepository } from "../repositories/brain-repo";
import { loadSettings } from "../settings";

export const TOOL_MANIFEST = [
  "brain_search",
  "brain_query",
  "brain_get",
  "brain_put",
  "brain_delete",
  "brain_ingest",
  "brain_link",
  "brain_backlinks",
  "brain_timeline",
  "brain_timeline_add",
  "brain_timeline_list",
  "brain_timeline_delete",
  "brain_timeline_extract",
  "brain_compile",
  "brain_smart_ingest",
  "brain_tags",
  "brain_tag",
  "brain_list",
  "brain_stats",
  "brain_raw",
];

export async function startMcpServer(dbPath: string): Promise<void> {
  const db = await BrainDb.connect(dbPath);
  const repo = new BrainRepository(db);
  const settings = await loadSettings();
  const server = new McpServer({ name: "ebrain", version: "0.2.0" });

  // ---------------------------------------------------------------------------
  // Search & Query Tools
  // ---------------------------------------------------------------------------

  server.registerTool(
    "brain_search",
    {
      description: "Full-text search (hybridSearch without KNN)",
      inputSchema: z.object({
        query: z.string(),
        type: z.string().optional(),
        limit: z.number().int().positive().max(50).optional(),
      }),
    },
    async ({ query, type, limit }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await repo.search(query, limit ?? 10, type),
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerTool(
    "brain_query",
    {
      description: "Semantic query using vector embeddings",
      inputSchema: z.object({
        question: z.string(),
        limit: z.number().int().positive().max(50).optional(),
      }),
    },
    async ({ question, limit }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await repo.query(question, limit ?? 10), null, 2),
        },
      ],
    }),
  );

  // ---------------------------------------------------------------------------
  // Page CRUD Tools
  // ---------------------------------------------------------------------------

  server.registerTool(
    "brain_get",
    {
      description: "Read a page and return its full content",
      inputSchema: z.object({ slug: z.string() }),
    },
    async ({ slug }) => ({
      content: [
        { type: "text", text: JSON.stringify(await repo.getPage(slug), null, 2) },
      ],
    }),
  );

  server.registerTool(
    "brain_put",
    {
      description: "Write or update a page",
      inputSchema: z.object({
        slug: z.string(),
        content: z.string(),
        type: z.string().optional(),
        title: z.string().optional(),
      }),
    },
    async ({ slug, content, type, title }) => {
      const page = await repo.putPage({
        slug,
        type: type ?? "note",
        title: title ?? slug,
        compiledTruth: content,
        timeline: "",
      });
      return { content: [{ type: "text", text: JSON.stringify(page, null, 2) }] };
    },
  );

  server.registerTool(
    "brain_delete",
    {
      description: "Delete a page and all its related data (links, tags, timeline, raw)",
      inputSchema: z.object({ slug: z.string() }),
    },
    async ({ slug }) => {
      await repo.deletePage(slug);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, action: "delete", slug }) }] };
    },
  );

  server.registerTool(
    "brain_ingest",
    {
      description: "Ingest source content as a new page (simple ingestion)",
      inputSchema: z.object({
        content: z.string(),
        source_type: z.string(),
        source_ref: z.string(),
      }),
    },
    async ({ content, source_type, source_ref }) => {
      const safeRef = source_ref.replace(/[^a-zA-Z0-9/_-]+/g, "_").slice(0, 200);
      const slug = `ingest/${safeRef || "untitled"}`;
      const page = await repo.putPage({
        slug,
        type: source_type,
        title: source_ref,
        compiledTruth: content,
        timeline: "",
        frontmatter: { source_type, source_ref },
      });
      return { content: [{ type: "text", text: JSON.stringify(page, null, 2) }] };
    },
  );

  // ---------------------------------------------------------------------------
  // Link Tools
  // ---------------------------------------------------------------------------

  server.registerTool(
    "brain_link",
    {
      description: "Create a cross-link between two pages",
      inputSchema: z.object({
        from: z.string(),
        to: z.string(),
        context: z.string().optional(),
      }),
    },
    async ({ from, to, context }) => {
      await repo.link(from, to, context ?? "");
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    },
  );

  server.registerTool(
    "brain_backlinks",
    {
      description: "List pages that link to this page",
      inputSchema: z.object({ slug: z.string() }),
    },
    async ({ slug }) => ({
      content: [
        { type: "text", text: JSON.stringify(await repo.backlinks(slug), null, 2) },
      ],
    }),
  );

  // ---------------------------------------------------------------------------
  // Timeline Tools (Enhanced)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "brain_timeline",
    {
      description: "List timeline entries for a specific page",
      inputSchema: z.object({
        slug: z.string(),
        limit: z.number().int().positive().max(200).optional(),
      }),
    },
    async ({ slug, limit }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await repo.timeline(slug, limit ?? 50), null, 2),
        },
      ],
    }),
  );

  server.registerTool(
    "brain_timeline_add",
    {
      description: "Append a timeline entry to a page",
      inputSchema: z.object({
        slug: z.string().describe("Page slug"),
        date: z.string().describe("Date in YYYY-MM-DD format"),
        summary: z.string().describe("One-line summary (max 120 chars)"),
        source: z.string().optional().describe("Source identifier"),
        detail: z.string().optional().describe("Optional markdown detail"),
      }),
    },
    async ({ slug, date, summary, source, detail }) => {
      await repo.timelineAdd({
        pageSlug: slug,
        date,
        summary,
        source: source ?? "manual",
        detail: detail ?? "",
      });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    },
  );

  server.registerTool(
    "brain_timeline_list",
    {
      description: "List timeline entries across all pages (global timeline view)",
      inputSchema: z.object({
        limit: z.number().int().positive().max(200).optional(),
      }),
    },
    async ({ limit }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await repo.timelineGlobal(limit ?? 100), null, 2),
        },
      ],
    }),
  );

  server.registerTool(
    "brain_timeline_delete",
    {
      description: "Delete a specific timeline entry by ID",
      inputSchema: z.object({
        id: z.number().int().positive().describe("Timeline entry ID to delete"),
      }),
    },
    async ({ id }) => {
      await repo.timelineDelete(id);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, action: "timeline-delete", id }) }] };
    },
  );

  server.registerTool(
    "brain_timeline_extract",
    {
      description: "Extract timeline events from content using AI. Adds extracted entries to page timeline.",
      inputSchema: z.object({
        slug: z.string().describe("Page slug to add timeline entries to"),
        content: z.string().describe("Content to extract timeline events from"),
        source: z.string().optional().describe("Source identifier"),
        default_date: z.string().optional().describe("Default date (YYYY-MM-DD) for entries without explicit dates"),
      }),
    },
    async ({ slug, content, source, default_date }) => {
      const result = await repo.extractAndAddTimeline(
        slug,
        content,
        source ?? "extracted",
        default_date ?? new Date().toISOString().slice(0, 10),
        settings.llm,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              entriesAdded: result.entries.length,
              entries: result.entries,
              confidence: result.confidence,
            }, null, 2),
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Smart Compilation Tools (Core Brain Function)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "brain_compile",
    {
      description: "Intelligently compile new information into a page's compiled truth. Analyzes semantic meaning, updates/replaces outdated info, adds source attribution, and extracts timeline events. This is the core 'brain' function.",
      inputSchema: z.object({
        slug: z.string().describe("Page slug to compile into"),
        new_info: z.string().describe("New information to process (e.g., 'River AI closed Series A funding')"),
        source: z.string().optional().describe("Source of information (e.g., 'meeting_notes', 'news', 'user')"),
        date: z.string().optional().describe("Date of information (YYYY-MM-DD)"),
      }),
    },
    async ({ slug, new_info, source, date }) => {
      const result = await repo.compilePage(
        slug,
        new_info,
        source ?? "user",
        date ?? new Date().toISOString().slice(0, 10),
        settings.llm,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              slug,
              changed: result.changed,
              changeType: result.changeType,
              changeSummary: result.changeSummary,
              timelineEntriesAdded: result.timelineEntries.length,
              confidence: result.confidence,
              compiledTruthPreview: result.compiledTruth.slice(0, 500),
            }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "brain_smart_ingest",
    {
      description: "Full intelligent ingestion: compile truth, extract timeline, create entity links, sync to search. The complete pipeline for processing new content.",
      inputSchema: z.object({
        slug: z.string().describe("Page slug for the content"),
        content: z.string().describe("Full content to ingest"),
        source: z.string().optional().describe("Source identifier"),
        type: z.string().optional().describe("Page type (person, company, project, note, etc.)"),
      }),
    },
    async ({ slug, content, source, type }) => {
      const result = await repo.ingestContent(
        slug,
        content,
        source ?? "ingest",
        type ?? "note",
        settings.llm,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              slug: result.page.slug,
              compileResult: {
                changed: result.compileResult.changed,
                changeType: result.compileResult.changeType,
                changeSummary: result.compileResult.changeSummary,
                confidence: result.compileResult.confidence,
              },
              timelineResult: {
                entriesAdded: result.timelineResult.entries.length,
                confidence: result.timelineResult.confidence,
              },
              updatedAt: result.page.updatedAt,
            }, null, 2),
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Tag Tools
  // ---------------------------------------------------------------------------

  server.registerTool(
    "brain_tags",
    {
      description: "List tags on a page",
      inputSchema: z.object({ slug: z.string() }),
    },
    async ({ slug }) => ({
      content: [
        { type: "text", text: JSON.stringify(await repo.tags(slug), null, 2) },
      ],
    }),
  );

  server.registerTool(
    "brain_tag",
    {
      description: "Add or remove a tag from a page",
      inputSchema: z.object({
        slug: z.string(),
        tag: z.string(),
        remove: z.boolean().optional(),
      }),
    },
    async ({ slug, tag, remove }) => {
      if (remove) {
        await repo.untag(slug, tag);
      } else {
        await repo.tag(slug, tag);
      }
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    },
  );

  // ---------------------------------------------------------------------------
  // Query & List Tools
  // ---------------------------------------------------------------------------

  server.registerTool(
    "brain_list",
    {
      description: "List pages with optional filters",
      inputSchema: z.object({
        type: z.string().optional(),
        tag: z.string().optional(),
        limit: z.number().int().positive().optional(),
      }),
    },
    async ({ type, tag, limit }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await repo.listPages({ type, tag, limit: limit ?? 50 }),
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerTool(
    "brain_stats",
    { description: "Show knowledge base statistics", inputSchema: z.object({}) },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(await repo.stats(), null, 2) }],
    }),
  );

  server.registerTool(
    "brain_raw",
    {
      description: "Read or write raw source data for a page",
      inputSchema: z.object({
        slug: z.string(),
        source: z.string().optional(),
        data: z.unknown().optional(),
      }),
    },
    async ({ slug, source, data }) => {
      if (data !== undefined) {
        await repo.writeRaw(slug, source ?? "manual", data);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(await repo.readRaw(slug, source), null, 2),
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Resources
  // ---------------------------------------------------------------------------

  server.registerResource(
    "brain-index",
    "brain://index",
    { title: "Brain Index", description: "All page slugs grouped in plain list." },
    async () => {
      const slugs = await repo.allSlugs();
      return {
        contents: [
          {
            uri: "brain://index",
            mimeType: "text/plain",
            text: slugs.join("\n"),
          },
        ],
      };
    },
  );

  const pageTemplate = new ResourceTemplate("brain://pages/{slug}", {
    list: undefined,
  });
  server.registerResource(
    "brain-page",
    pageTemplate,
    { title: "Brain Page", description: "Single page JSON resource." },
    async (uri, vars) => {
      const slug = String(vars.slug ?? "");
      const page = await repo.getPage(slug);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(page, null, 2),
          },
        ],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}