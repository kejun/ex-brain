import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrainDb } from "../db/client";
import { BrainRepository } from "../repositories/brain-repo";
import { loadSettings } from "../settings";
import { loadDocument, type DocumentKind } from "../markdown/document-loader";

// ============================================================================
// Error Handling Utilities
// ============================================================================

interface ToolError {
  tool: string;
  error: string;
  message: string;
  timestamp: string;
  recoverable: boolean;
}

function formatError(toolName: string, error: unknown): ToolError {
  const err = error as Error;
  const errorType = err?.name ?? "UnknownError";
  const errorMessage = err?.message ?? String(error);
  
  // 判断是否可恢复
  const recoverablePatterns = [
    "ECONNREFUSED",
    "timeout",
    "ETIMEDOUT",
    "rate limit",
    "429",
    "503",
    "502",
    "timeout",
  ];
  const isRecoverable = recoverablePatterns.some(p => 
    errorMessage.toLowerCase().includes(p.toLowerCase())
  );

  return {
    tool: toolName,
    error: errorType,
    message: errorMessage,
    timestamp: new Date().toISOString(),
    recoverable: isRecoverable,
  };
}

function logError(toolName: string, error: unknown, params?: Record<string, unknown>): void {
  const errInfo = formatError(toolName, error);
  console.error(`[MCP Error] Tool: ${toolName}`);
  console.error(`  Type: ${errInfo.error}`);
  console.error(`  Message: ${errInfo.message}`);
  console.error(`  Recoverable: ${errInfo.recoverable}`);
  if (params) {
    console.error(`  Params: ${JSON.stringify(params)}`);
  }
  console.error(`  Timestamp: ${errInfo.timestamp}`);
}

/**
 * 包装工具 handler，添加错误处理
 * 确保工具错误不会导致 MCP Server 崩溃，返回友好的 JSON 错误信息
 */
function withErrorHandling<T extends Record<string, unknown>>(
  toolName: string,
  handler: (params: T) => Promise<{ content: Array<{ type: string; text: string }> }>
) {
  return async (params: T): Promise<{ content: Array<{ type: string; text: string }> }> => {
    try {
      return await handler(params);
    } catch (error) {
      logError(toolName, error, params);
      const errInfo = formatError(toolName, error);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              error: errInfo.error,
              message: errInfo.message,
              recoverable: errInfo.recoverable,
              hint: errInfo.recoverable 
                ? "This is a temporary error. Please try again later." 
                : "Please check the input parameters or system configuration.",
              tool: toolName,
            }, null, 2),
          },
        ],
      };
    }
  };
}

// 资源错误处理包装
function withResourceErrorHandling<T extends Record<string, string>>(
  resourceName: string,
  handler: (uri: URL, vars: T) => Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }>
) {
  return async (uri: URL, vars: T): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> => {
    try {
      return await handler(uri, vars);
    } catch (error) {
      logError(resourceName, error, vars as unknown as Record<string, unknown>);
      const errInfo = formatError(resourceName, error);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({
              ok: false,
              error: errInfo.error,
              message: errInfo.message,
              recoverable: errInfo.recoverable,
              resource: resourceName,
            }, null, 2),
          },
        ],
      };
    }
  };
}

export const TOOL_MANIFEST = [
  "brain_search",
  "brain_query",
  "brain_get",
  "brain_put",
  "brain_delete",
  "brain_ingest",
  "brain_ingest_document",
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

  // Tool handler functions (wrapped with error handling below)
  const brainSearchHandler = async ({ query, type, limit }: { query: string; type?: string; limit?: number }) => ({
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
  });

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
    withErrorHandling("brain_search", brainSearchHandler),
  );

  const brainQueryHandler = async ({ question, limit }: { question: string; limit?: number }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(await repo.query(question, limit ?? 10), null, 2),
      },
    ],
  });

  server.registerTool(
    "brain_query",
    {
      description: "Semantic query using vector embeddings",
      inputSchema: z.object({
        question: z.string(),
        limit: z.number().int().positive().max(50).optional(),
      }),
    },
    withErrorHandling("brain_query", brainQueryHandler),
  );

  // ---------------------------------------------------------------------------
  // Page CRUD Tools
  // ---------------------------------------------------------------------------

  const brainGetHandler = async ({ slug }: { slug: string }) => ({
    content: [
      { type: "text", text: JSON.stringify(await repo.getPage(slug), null, 2) },
    ],
  });

  server.registerTool(
    "brain_get",
    {
      description: "Read a page and return its full content",
      inputSchema: z.object({ slug: z.string() }),
    },
    withErrorHandling("brain_get", brainGetHandler),
  );

  const brainPutHandler = async ({ slug, content, type, title }: { slug: string; content: string; type?: string; title?: string }) => {
    const page = await repo.putPage({
      slug,
      type: type ?? "note",
      title: title ?? slug,
      compiledTruth: content,
      timeline: "",
    });
    return { content: [{ type: "text", text: JSON.stringify(page, null, 2) }] };
  };

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
    withErrorHandling("brain_put", brainPutHandler),
  );

  const brainDeleteHandler = async ({ slug }: { slug: string }) => {
    await repo.deletePage(slug);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, action: "delete", slug }) }] };
  };

  server.registerTool(
    "brain_delete",
    {
      description: "Delete a page and all its related data (links, tags, timeline, raw)",
      inputSchema: z.object({ slug: z.string() }),
    },
    withErrorHandling("brain_delete", brainDeleteHandler),
  );

  const brainIngestHandler = async ({ content, source_type, source_ref }: { content: string; source_type: string; source_ref: string }) => {
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
  };

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
    withErrorHandling("brain_ingest", brainIngestHandler),
  );

  // -- brain_ingest_document: ingest a PDF/Word/HTML/text file or http(s) URL
  const brainIngestDocumentHandler = async ({
    source,
    slug,
    type,
    format,
    max_bytes,
    timeout_ms,
  }: {
    source: string;
    slug?: string;
    type?: string;
    format?: DocumentKind;
    max_bytes?: number;
    timeout_ms?: number;
  }) => {
    const loaded = await loadDocument(source, {
      forceKind: format,
      maxBytes: max_bytes,
      fetchTimeoutMs: timeout_ms,
    });
    const slugBase =
      loaded.fileName
        .replace(/\.[^.]+$/, "")
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "document";
    const finalSlug = slug ?? `ingest/${slugBase}`;
    const finalType = type ?? loaded.kind;
    const page = await repo.putPage({
      slug: finalSlug,
      type: finalType,
      title: loaded.fileName,
      compiledTruth: loaded.text,
      timeline: "",
      frontmatter: {
        sourceFile: loaded.source,
        sourceType: loaded.sourceType,
        sourceKind: loaded.kind,
        sourceMimeType: loaded.mimeType,
        sourceBytes: loaded.bytes,
        sourceFileName: loaded.fileName,
        ...loaded.metadata,
      },
    });
    try {
      await repo.timelineAdd({
        pageSlug: finalSlug,
        date: new Date().toISOString().slice(0, 10),
        source: finalType,
        summary: `Ingested ${loaded.kind} ${loaded.fileName}`,
        detail:
          loaded.sourceType === "url" ? `Source URL: ${loaded.source}` : "",
      });
    } catch {
      /* non-fatal */
    }
    try {
      await repo.writeRaw(finalSlug, loaded.sourceType, {
        fileName: loaded.fileName,
        sourceRef: loaded.source,
        kind: loaded.kind,
        mimeType: loaded.mimeType,
        bytes: loaded.bytes,
        metadata: loaded.metadata,
        ingestedAt: new Date().toISOString(),
      });
    } catch {
      /* non-fatal */
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              slug: finalSlug,
              kind: loaded.kind,
              sourceType: loaded.sourceType,
              sourceRef: loaded.source,
              fileName: loaded.fileName,
              mimeType: loaded.mimeType,
              bytes: loaded.bytes,
              contentLength: loaded.text.length,
              page: { slug: page.slug, updatedAt: page.updatedAt },
              metadata: loaded.metadata,
            },
            null,
            2,
          ),
        },
      ],
    };
  };

  server.registerTool(
    "brain_ingest_document",
    {
      description:
        "Ingest a document (PDF, Word .docx, HTML, JSON, plain text, markdown) from a local file path or http(s) URL. Extracts text content automatically based on file extension or HTTP content-type.",
      inputSchema: z.object({
        source: z
          .string()
          .describe("Local file path or http(s) URL to ingest."),
        slug: z
          .string()
          .optional()
          .describe(
            "Optional explicit page slug. Defaults to 'ingest/<sanitized-filename>'.",
          ),
        type: z
          .string()
          .optional()
          .describe("Optional page type override (defaults to detected kind)."),
        format: z
          .enum([
            "text",
            "markdown",
            "pdf",
            "docx",
            "doc",
            "html",
            "json",
            "unknown",
          ])
          .optional()
          .describe("Force a specific document kind, bypassing auto-detection."),
        max_bytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum bytes accepted from URL/file. Default 50MB."),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Network fetch timeout for URLs in ms. Default 30000."),
      }),
    },
    withErrorHandling("brain_ingest_document", brainIngestDocumentHandler),
  );

  // ---------------------------------------------------------------------------
  // Link Tools
  // ---------------------------------------------------------------------------

  const brainLinkHandler = async ({ from, to, context }: { from: string; to: string; context?: string }) => {
    await repo.link(from, to, context ?? "");
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  };

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
    withErrorHandling("brain_link", brainLinkHandler),
  );

  const brainBacklinksHandler = async ({ slug }: { slug: string }) => ({
    content: [
      { type: "text", text: JSON.stringify(await repo.backlinks(slug), null, 2) },
    ],
  });

  server.registerTool(
    "brain_backlinks",
    {
      description: "List pages that link to this page",
      inputSchema: z.object({ slug: z.string() }),
    },
    withErrorHandling("brain_backlinks", brainBacklinksHandler),
  );

  // ---------------------------------------------------------------------------
  // Timeline Tools (Enhanced)
  // ---------------------------------------------------------------------------

  const brainTimelineHandler = async ({ slug, limit }: { slug: string; limit?: number }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(await repo.timeline(slug, limit ?? 50), null, 2),
      },
    ],
  });

  server.registerTool(
    "brain_timeline",
    {
      description: "List timeline entries for a specific page",
      inputSchema: z.object({
        slug: z.string(),
        limit: z.number().int().positive().max(200).optional(),
      }),
    },
    withErrorHandling("brain_timeline", brainTimelineHandler),
  );

  const brainTimelineAddHandler = async ({ slug, date, summary, source, detail }: { slug: string; date: string; summary: string; source?: string; detail?: string }) => {
    await repo.timelineAdd({
      pageSlug: slug,
      date,
      summary,
      source: source ?? "manual",
      detail: detail ?? "",
    });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  };

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
    withErrorHandling("brain_timeline_add", brainTimelineAddHandler),
  );

  const brainTimelineListHandler = async ({ limit }: { limit?: number }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(await repo.timelineGlobal(limit ?? 100), null, 2),
      },
    ],
  });

  server.registerTool(
    "brain_timeline_list",
    {
      description: "List timeline entries across all pages (global timeline view)",
      inputSchema: z.object({
        limit: z.number().int().positive().max(200).optional(),
      }),
    },
    withErrorHandling("brain_timeline_list", brainTimelineListHandler),
  );

  const brainTimelineDeleteHandler = async ({ id }: { id: number }) => {
    await repo.timelineDelete(id);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, action: "timeline-delete", id }) }] };
  };

  server.registerTool(
    "brain_timeline_delete",
    {
      description: "Delete a specific timeline entry by ID",
      inputSchema: z.object({
        id: z.number().int().positive().describe("Timeline entry ID to delete"),
      }),
    },
    withErrorHandling("brain_timeline_delete", brainTimelineDeleteHandler),
  );

  const brainTimelineExtractHandler = async ({ slug, content, source, default_date }: { slug: string; content: string; source?: string; default_date?: string }) => {
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
  };

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
    withErrorHandling("brain_timeline_extract", brainTimelineExtractHandler),
  );

  // ---------------------------------------------------------------------------
  // Smart Compilation Tools (Core Brain Function)
  // ---------------------------------------------------------------------------

  const brainCompileHandler = async ({ slug, new_info, source, date }: { slug: string; new_info: string; source?: string; date?: string }) => {
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
  };

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
    withErrorHandling("brain_compile", brainCompileHandler),
  );

  const brainSmartIngestHandler = async ({ slug, content, source, type }: { slug: string; content: string; source?: string; type?: string }) => {
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
  };

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
    withErrorHandling("brain_smart_ingest", brainSmartIngestHandler),
  );

  // ---------------------------------------------------------------------------
  // Tag Tools
  // ---------------------------------------------------------------------------

  const brainTagsHandler = async ({ slug }: { slug: string }) => ({
    content: [
      { type: "text", text: JSON.stringify(await repo.tags(slug), null, 2) },
    ],
  });

  server.registerTool(
    "brain_tags",
    {
      description: "List tags on a page",
      inputSchema: z.object({ slug: z.string() }),
    },
    withErrorHandling("brain_tags", brainTagsHandler),
  );

  const brainTagHandler = async ({ slug, tag, remove }: { slug: string; tag: string; remove?: boolean }) => {
    if (remove) {
      await repo.untag(slug, tag);
    } else {
      await repo.tag(slug, tag);
    }
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  };

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
    withErrorHandling("brain_tag", brainTagHandler),
  );

  // ---------------------------------------------------------------------------
  // Query & List Tools
  // ---------------------------------------------------------------------------

  const brainListHandler = async ({ type, tag, limit }: { type?: string; tag?: string; limit?: number }) => ({
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
  });

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
    withErrorHandling("brain_list", brainListHandler),
  );

  const brainStatsHandler = async () => ({
    content: [{ type: "text", text: JSON.stringify(await repo.stats(), null, 2) }],
  });

  server.registerTool(
    "brain_stats",
    { description: "Show knowledge base statistics", inputSchema: z.object({}) },
    withErrorHandling("brain_stats", brainStatsHandler),
  );

  const brainRawHandler = async ({ slug, source, data }: { slug: string; source?: string; data?: unknown }) => {
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
  };

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
    withErrorHandling("brain_raw", brainRawHandler),
  );

  // ---------------------------------------------------------------------------
  // Resources
  // ---------------------------------------------------------------------------

  const brainIndexHandler = async () => {
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
  };

  server.registerResource(
    "brain-index",
    "brain://index",
    { title: "Brain Index", description: "All page slugs grouped in plain list." },
    withResourceErrorHandling("brain-index", brainIndexHandler),
  );

  const brainPageHandler = async (uri: URL, vars: { slug?: string }) => {
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
  };

  const pageTemplate = new ResourceTemplate("brain://pages/{slug}", {
    list: undefined,
  });
  server.registerResource(
    "brain-page",
    pageTemplate,
    { title: "Brain Page", description: "Single page JSON resource." },
    withResourceErrorHandling("brain-page", brainPageHandler),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}