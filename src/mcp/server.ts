import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrainDb } from "../db/client";
import { BrainRepository } from "../repositories/brain-repo";

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
  "brain_tags",
  "brain_tag",
  "brain_list",
  "brain_stats",
  "brain_raw",
];

export async function startMcpServer(dbPath: string): Promise<void> {
  const db = await BrainDb.connect(dbPath);
  const repo = new BrainRepository(db);
  const server = new McpServer({ name: "ebrain", version: "0.1.0" });

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
      description: "semantic query",
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

  server.registerTool(
    "brain_get",
    {
      description: "read page",
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
      description: "write page",
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
      description: "delete a page and its related data",
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
      description: "ingest source content as a new page",
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

  server.registerTool(
    "brain_link",
    {
      description: "create cross link",
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
    "brain_timeline",
    {
      description: "list timeline entries",
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
      description: "append timeline entry",
      inputSchema: z.object({
        slug: z.string(),
        date: z.string(),
        summary: z.string(),
        source: z.string().optional(),
        detail: z.string().optional(),
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
    "brain_tags",
    {
      description: "list tags",
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
      description: "add/remove tag",
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

  server.registerTool(
    "brain_list",
    {
      description: "list pages",
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
    "brain_backlinks",
    {
      description: "read backlinks",
      inputSchema: z.object({ slug: z.string() }),
    },
    async ({ slug }) => ({
      content: [
        { type: "text", text: JSON.stringify(await repo.backlinks(slug), null, 2) },
      ],
    }),
  );

  server.registerTool(
    "brain_stats",
    { description: "stats", inputSchema: z.object({}) },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(await repo.stats(), null, 2) }],
    }),
  );

  server.registerTool(
    "brain_raw",
    {
      description: "read/write raw source data",
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
