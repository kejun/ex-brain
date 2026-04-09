import { basename, resolve } from "node:path";
import { Command } from "commander";
import { DEFAULT_DB_NAME, inferTypeFromSlug, slugToTitle, normalizeLongSlug, slugify } from "../config";
import { BrainDb } from "../db/client";
import {
  collectMarkdownFiles,
  ensureDir,
  fileExists,
  pathToSlug,
  readMaybeStdin,
  readTextFile,
  slugToPath,
  writeTextFile,
} from "../markdown/io";
import {
  extractTimelineLines,
  extractWikiStyleLinks,
  parsePageMarkdown,
  renderPageMarkdown,
} from "../markdown/parser";
import { BrainRepository } from "../repositories/brain-repo";
import { loadSettings, SETTINGS_PATH, DEFAULT_DB_PATH, type ResolvedLLM } from "../settings";
import { extractRelations, entityToSlug, type EntityType } from "../ai/entity-link";
import { registerCompileCommands } from "./compile-cmd";
import { registerGraphCommand } from "./graph-cmd";
import { createProgress, formatDuration } from "../utils/progress";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addDryRun(cmd: Command): Command {
  return cmd.option("--dry-run", "preview changes without executing", false);
}

function isDryRun(opts: Record<string, unknown>): boolean {
  return Boolean(opts.dryRun);
}

// Simple progress output to stderr (won't interfere with --json stdout).
// e.g. "[3/42] import docs/api"
function progress(label: string, current: number, total: number, json: boolean): void {
  if (json) return;
  process.stderr.write(`[${current}/${total}] ${label}\n`);
}

/**
 * Extract entities and create entity pages + links.
 * Non-blocking: failures produce warnings, not errors.
 */
async function applyEntityLinks(
  repo: BrainRepository,
  sourceSlug: string,
  content: string,
  json: boolean,
): Promise<{ created: number; linked: number }> {
  if (!content.trim()) return { created: 0, linked: 0 };

  const settings = await loadSettings();
  if (!settings.llm.baseURL) {
    if (!json) {
      process.stderr.write(`[entity-link] LLM not configured, skipping for ${sourceSlug}\n`);
    }
    return { created: 0, linked: 0 };
  }

  const progress = createProgress();
  if (!json) {
    progress.start(`Extracting entities from ${sourceSlug}`);
  }

  const startTime = Date.now();
  const relations = await extractRelations(content, settings.llm);
  
  // Filter by confidence
  const highConfidence = relations.filter((r) => r.confidence >= 0.6);
  const ignoredCount = relations.length - highConfidence.length;
  
  if (highConfidence.length === 0) {
    if (!json) {
      progress.fail(`No high-confidence entities found`);
    }
    return { created: 0, linked: 0 };
  }

  let created = 0;
  let linked = 0;

  for (const r of highConfidence) {
    // 1. Resolve entity slugs (disambiguation)
    const fromCandidate = entityToSlug(r.from.name, r.from.type);
    const toCandidate = entityToSlug(r.to.name, r.to.type);
    
    const fromSlug = await repo.findSimilarSlug(fromCandidate, r.from.name);
    const toSlug = await repo.findSimilarSlug(toCandidate, r.to.name);

    // 2. Ensure entity pages exist
    const c1 = await repo.ensureEntityPage(fromSlug, r.from.type, r.from.name, r.relation, r.context, sourceSlug);
    const c2 = await repo.ensureEntityPage(toSlug, r.to.type, r.to.name, r.relation, r.context, sourceSlug);
    if (c1) created += 1;
    if (c2) created += 1;

    // 3. Link between entities (context includes relation type)
    await repo.link(fromSlug, toSlug, `[${r.relation}] ${r.context}`);
    linked += 1;

    // 4. Link from source document to entities (for backlinks tracing)
    await repo.link(sourceSlug, fromSlug, `Mentions ${r.from.name}`);
    linked += 1;
    await repo.link(sourceSlug, toSlug, `Mentions ${r.to.name}`);
    linked += 1;
  }

  if (!json) {
    const duration = formatDuration(Date.now() - startTime);
    const entityNames = highConfidence.flatMap((r) => [r.from.name, r.to.name]);
    progress.succeed(`${[...new Set(entityNames)].join(", ")} (${created} created, ${linked} links, ${duration})`);
  }

  return { created, linked };
}

async function resolveInput(
  fileOpt: string | undefined,
  stdin: boolean,
): Promise<string> {
  if (fileOpt) return readTextFile(resolve(fileOpt));
  return readMaybeStdin().then((s) => s ?? "");
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildProgram(): Command {
  const program = new Command("ebrain")
    .description("Personal knowledge base CLI powered by seekdb")
    .addHelpText(
      "after",
      `
Examples:
  ebrain config
  ebrain put docs/api --file api.md
  ebrain search "machine learning" --limit 5
  ebrain query "What projects did we ship in Q4?"
  cat note.md | ebrain put notes/daily --stdin
  ebrain serve   # start MCP server for AI tools
`,
    )
    .option("--db <path>", "database path (overrides settings.json)")
    .option("--json", "output as JSON", false);

  // -- config ---------------------------------------------------------------

  program
    .command("config")
    .description("show resolved configuration")
    .action(async () => {
      const settings = await loadSettings();
      const cliDb = program.opts().db;
      const effectiveDb = cliDb ?? settings.dbPath;
      print(program, {
        settingsFile: SETTINGS_PATH,
        dbPath: effectiveDb,
        mode: settings.remote ? "remote" : "local",
        remote: settings.remote ?? null,
        embed: {
          provider: settings.embed.provider,
          baseURL: settings.embed.baseURL,
          model: settings.embed.model,
          dimensions: settings.embed.dimensions,
          hasApiKey:
            !!settings.embed.apiKey ||
            !!process.env[settings.embed.apiKeyEnv],
        },
        llm: {
          baseURL: settings.llm.baseURL || "(not configured)",
          model: settings.llm.model,
          hasApiKey:
            !!settings.llm.apiKey ||
            !!process.env[settings.llm.apiKeyEnv],
        },
      });
    });

  // -- page CRUD ------------------------------------------------------------

  addDryRun(
    program
      .command("put")
      .argument("[slug]", "page slug (optional; auto-generated if omitted)")
      .option("--file <path>", "read markdown from file")
      .option("--stdin", "read markdown from stdin", false)
      .option("--type <type>", "page type")
      .option("--title <title>", "page title")
      .description(
        "create or update a page (idempotent; upserts by slug). If slug is omitted, it is auto-generated from file name, title, or timestamp.",
      )
      .addHelpText(
        "after",
        `
Examples:
  ebrain put --file api.md                  # auto-generate slug from file name
  ebrain put docs/api --file api.md         # explicit slug
  cat note.md | ebrain put --stdin          # auto-generate slug from title/timestamp
  ebrain put --title "My Note" --stdin      # auto-generate slug from title
  ebrain put people/john --type person --title "John Doe"
  ebrain put docs/api --file api.md --dry-run
`,
      ),
  ).action(
    async (
      slug: string | undefined,
      opts: {
        file?: string;
        stdin?: boolean;
        type?: string;
        title?: string;
        dryRun?: boolean;
      },
    ) => {
      const input = await resolveInput(opts.file, opts.stdin ?? false);
      if (!input.trim()) {
        throw new Error(
          "empty input — provide --file <path>, --stdin, or pipe markdown",
        );
      }
      const parsed = parsePageMarkdown(input);
      
      // Auto-generate slug if not provided
      let finalSlug = slug;
      if (!finalSlug) {
        // Priority: file name > title option > frontmatter title > timestamp
        if (opts.file) {
          const fileName = basename(opts.file).replace(/\.md$/i, "");
          finalSlug = normalizeLongSlug(slugify(fileName));
        } else if (opts.title) {
          finalSlug = normalizeLongSlug(slugify(opts.title));
        } else if (parsed.frontmatter.title) {
          finalSlug = normalizeLongSlug(slugify(String(parsed.frontmatter.title)));
        } else {
          // Use timestamp as fallback
          const timestamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
          finalSlug = `notes/${timestamp}`;
        }
      }
      
      const type =
        opts.type ??
        String(parsed.frontmatter.type ?? inferTypeFromSlug(finalSlug));
      const title =
        opts.title ??
        String(parsed.frontmatter.title ?? slugToTitle(finalSlug));

      if (isDryRun(opts)) {
        print(program, {
          dryRun: true,
          action: "put",
          slug: finalSlug,
          type,
          title,
          contentLength: parsed.compiledTruth.length,
          hasTimeline: !!parsed.timeline,
          frontmatterKeys: Object.keys(parsed.frontmatter),
        });
        return;
      }

      await withRepo(program, async (repo) => {
        const page = await repo.putPage({
          slug: finalSlug,
          type,
          title,
          compiledTruth: parsed.compiledTruth,
          timeline: parsed.timeline,
          frontmatter: parsed.frontmatter,
        });
        await applyEntityLinks(
          repo,
          finalSlug,
          parsed.compiledTruth,
          isJson(program),
        );
        print(program, { ok: true, slug: page.slug, updatedAt: page.updatedAt });
      });
    },
  );

  program
    .command("get")
    .argument("<slug>", "page slug")
    .option("--json", "output as JSON (overrides global --json)")
    .description("read a page and render it as markdown")
    .addHelpText(
      "after",
      `
Examples:
  ebrain get docs/api
  ebrain get docs/api --json
`,
    )
    .action(async (slug: string, opts: { json?: boolean }) => {
    const localJson = opts.json !== undefined ? opts.json : isJson(program);
      await withRepo(program, async (repo) => {
        const page = await repo.getPage(slug);
        if (!page) {
          throw new Error(`page not found: ${slug}`);
        }
        if (localJson) {
          console.log(JSON.stringify(page, null, 2));
          return;
        }
        console.log(
          renderPageMarkdown(
            page.frontmatter,
            page.compiledTruth,
            page.timeline,
          ),
        );
      });
    });

  addDryRun(
    program
      .command("delete")
      .argument("<slug>", "page slug to delete")
      .description("delete a page and its related data (links, tags, timeline, raw)")
      .addHelpText(
        "after",
        `
Examples:
  ebrain delete notes/old-draft
  ebrain delete notes/old-draft --dry-run
`,
      ),
  ).action(async (slug: string, opts: { dryRun?: boolean }) => {
    if (isDryRun(opts)) {
      await withRepo(program, async (repo) => {
        const page = await repo.getPage(slug);
        if (!page) {
          throw new Error(`page not found: ${slug}`);
        }
        print(program, {
          dryRun: true,
          action: "delete",
          slug,
          title: page.title,
        });
      });
      return;
    }
    await withRepo(program, async (repo) => {
      await repo.deletePage(slug);
      print(program, { ok: true, action: "delete", slug });
    });
  });

  program
    .command("list")
    .option("--type <type>", "filter by page type")
    .option("--tag <tag>", "filter by tag")
    .option("-f, --fields <fields>", "comma-separated fields to display (slug,type,title,createdAt,updatedAt)")
    .option("--limit <number>", "max results", "50")
    .description("list pages")
    .addHelpText(
      "after",
      `
Examples:
  ebrain list
  ebrain list --type person
  ebrain list -f slug
  ebrain list -f slug,title,type
`,
    )
    .action(async (opts: Record<string, string | undefined>) => {
      await withRepo(program, async (repo) => {
        const rows = await repo.listPages({
          type: opts.type,
          tag: opts.tag,
          limit: Number(opts.limit),
        });

        // When --fields is set, show one page per line with tab-separated values
        if (opts.fields) {
          const fields = opts.fields.split(",").map((f) => f.trim());
          for (const row of rows) {
            const vals = fields.map((field) => {
              const val = (row as Record<string, unknown>)[field];
              if (val === undefined || val === null) return "";
              if (typeof val === "object") return JSON.stringify(val);
              return String(val);
            });
            console.log(vals.join("\t"));
          }
          return;
        }

        print(program, rows);
      });
    });

  // -- search / query -------------------------------------------------------

  program
    .command("search")
    .argument("<query>", "full-text search query")
    .option("--type <type>", "filter by page type")
    .option("--limit <number>", "max results", "10")
    .description("full-text / hybrid search")
    .addHelpText(
      "after",
      `
Examples:
  ebrain search "machine learning"
  ebrain search "quarterly revenue" --type deal --limit 5
`,
    )
    .action(async (query: string, opts: Record<string, string>) => {
      await withRepo(program, async (repo) => {
        const hits = await repo.search(
          query,
          Number(opts.limit ?? 10),
          opts.type,
        );
        print(program, hits);
      });
    });

  program
    .command("query")
    .argument("<question>", "natural language question")
    .option("--limit <number>", "max results", "10")
    .option("--llm", "use LLM to answer based on retrieved context", false)
    .option("--context-limit <number>", "max pages to use as context", "5")
    .description("semantic / vector search")
    .addHelpText(
      "after",
      `
Examples:
  ebrain query "What projects did we ship in Q4?"
  ebrain query "Who leads the ML team?" --limit 5
  ebrain query "What are the key findings?" --llm
`,
    )
    .action(async (question: string, opts: Record<string, string>) => {
      await withRepo(program, async (repo) => {
        const limit = Number(opts.limit ?? 10);
        const hits = await repo.query(question, limit);
        
        // If --llm flag, generate answer based on context
        if (opts.llm) {
          const settings = await loadSettings();
          if (!settings.llm.baseURL) {
            print(program, { error: "LLM not configured. Set llm.baseURL in settings." });
            return;
          }
          
          const progress = createProgress();
          progress.start("Searching knowledge base...");
          
          // Use excerpts from hits as context (avoids extra DB queries that cause segfault)
          const contextLimit = Number(opts.contextLimit ?? 5);
          const topHits = hits.slice(0, contextLimit);
          
          // Build context from search results
          const contextPages = topHits.map(hit => ({
            slug: hit.slug,
            title: hit.title,
            excerpt: hit.excerpt || "",
          }));
          
          progress.update("Generating answer...");
          const startTime = Date.now();
          
          const answer = await generateAnswerFromExcerpts(question, contextPages, settings.llm);
          
          const duration = formatDuration(Date.now() - startTime);
          progress.succeed(`Answer generated (${duration})`);
          
          // Output markdown
          console.log("\n" + answer);
          
          // Show sources
          if (contextPages.length > 0) {
            console.log("\n---\n**Sources:**\n");
            contextPages.forEach((p, i) => {
              console.log(`${i + 1}. [[${p.slug}|${p.title}]]`);
            });
          }
        } else {
          print(program, hits);
        }
      });
    });

  // -- link -----------------------------------------------------------------

  addDryRun(
    program
      .command("link")
      .argument("<from>", "source page slug")
      .argument("<to>", "target page slug")
      .option("--context <text>", "link context", "")
      .description("create a cross-link between pages (idempotent)")
      .addHelpText(
        "after",
        `
Examples:
  ebrain link docs/api docs/getting-started
  ebrain link people/john projects/alpha --context "lead"
  ebrain link docs/api docs/getting-started --dry-run
`,
      ),
  ).action(
    async (
      from: string,
      to: string,
      opts: { context?: string; dryRun?: boolean },
    ) => {
      if (isDryRun(opts)) {
        print(program, {
          dryRun: true,
          action: "link",
          from,
          to,
          context: opts.context ?? "",
        });
        return;
      }
      await withRepo(program, async (repo) => {
        await repo.link(from, to, opts.context ?? "");
        print(program, { ok: true, from, to });
      });
    },
  );

  program
    .command("backlinks")
    .argument("<slug>", "target page slug")
    .description("list pages that link to this page")
    .addHelpText(
      "after",
      `
Examples:
  ebrain backlinks docs/api
`,
    )
    .action(async (slug: string) => {
      await withRepo(program, async (repo) => {
        const links = await repo.backlinks(slug);
        print(program, links);
      });
    });

  // -- timeline (subcommands) -----------------------------------------------

  const timelineCmd = program
    .command("timeline")
    .description("manage timeline entries");

  timelineCmd
    .command("list")
    .argument("<slug>", "page slug")
    .option("--limit <number>", "max results", "50")
    .description("list timeline entries for a page")
    .addHelpText(
      "after",
      `
Examples:
  ebrain timeline list projects/alpha
  ebrain timeline list projects/alpha --limit 10
`,
    )
    .action(async (slug: string, opts: Record<string, string>) => {
      await withRepo(program, async (repo) => {
        const rows = await repo.timeline(slug, Number(opts.limit ?? 50));
        print(program, rows);
      });
    });

  addDryRun(
    timelineCmd
      .command("add")
      .argument("<slug>", "page slug")
      .requiredOption("--date <date>", "date (YYYY-MM-DD or ISO)")
      .requiredOption("--summary <summary>", "one-line summary")
      .option("--source <source>", "event source", "manual")
      .option("--detail <detail>", "detail markdown", "")
      .description("add a timeline entry")
      .addHelpText(
        "after",
        `
Examples:
  ebrain timeline add projects/alpha --date 2025-03-15 --summary "v1.0 shipped"
  ebrain timeline add projects/alpha --date 2025-03-15 --summary "launch" --source release
  ebrain timeline add projects/alpha --date 2025-03-15 --summary "launch" --dry-run
`,
      ),
  ).action(
    async (
      slug: string,
      opts: {
        date: string;
        summary: string;
        source?: string;
        detail?: string;
        dryRun?: boolean;
      },
    ) => {
      if (isDryRun(opts)) {
        print(program, {
          dryRun: true,
          action: "timeline-add",
          slug,
          date: opts.date,
          summary: opts.summary,
          source: opts.source ?? "manual",
        });
        return;
      }
      await withRepo(program, async (repo) => {
        await repo.timelineAdd({
          pageSlug: slug,
          date: opts.date,
          source: opts.source ?? "manual",
          summary: opts.summary,
          detail: opts.detail ?? "",
        });
        print(program, {
          ok: true,
          action: "timeline-add",
          slug,
          date: opts.date,
        });
      });
    },
  );

  addDryRun(
    timelineCmd
      .command("extract")
      .argument("<slug>", "page slug")
      .option("--source <source>", "source identifier", "extracted")
      .option("--default-date <date>", "default date (YYYY-MM-DD)")
      .description("extract timeline events from page content using AI")
      .addHelpText(
        "after",
        `
Examples:
  ebrain timeline extract companies/river-ai
  ebrain timeline extract docs/meeting --source meeting_notes --default-date 2024-03-15
`,
      ),
  ).action(async (slug: string, opts: { source?: string; defaultDate?: string; dryRun?: boolean }) => {
    if (isDryRun(opts)) {
      print(program, {
        dryRun: true,
        action: "timeline-extract",
        slug,
        source: opts.source ?? "extracted",
        defaultDate: opts.defaultDate ?? new Date().toISOString().slice(0, 10),
      });
      return;
    }
    await withRepo(program, async (repo) => {
      const page = await repo.getPage(slug);
      if (!page) {
        throw new Error(`page not found: ${slug}`);
      }
      const settings = await loadSettings();
      
      const progress = createProgress();
      progress.start(`Extracting timeline from ${slug}...`);
      const startTime = Date.now();
      
      const result = await repo.extractAndAddTimeline(
        slug,
        page.compiledTruth,
        opts.source ?? "extracted",
        opts.defaultDate ?? new Date().toISOString().slice(0, 10),
        settings.llm,
      );
      
      const duration = formatDuration(Date.now() - startTime);
      
      if (result.entries.length > 0) {
        progress.succeed(`${result.entries.length} events extracted (${duration})`);
      } else {
        progress.stop();
        process.stderr.write(`No events found (${duration})\n`);
      }
      
      print(program, {
        ok: true,
        action: "timeline-extract",
        slug,
        entriesAdded: result.entries.length,
        entries: result.entries,
        confidence: result.confidence,
      });
    });
  });

  timelineCmd
    .command("global")
    .option("--limit <number>", "max results", "100")
    .description("list timeline entries across all pages")
    .addHelpText(
      "after",
        `
Examples:
  ebrain timeline global
  ebrain timeline global --limit 20
`,
    )
    .action(async (opts: Record<string, string>) => {
      await withRepo(program, async (repo) => {
        const entries = await repo.timelineGlobal(Number(opts.limit ?? 100));
        print(program, entries);
      });
    });

  // -- tag (subcommands) ----------------------------------------------------

  const tagCmd = program
    .command("tag")
    .description("manage tags on a page");

  tagCmd
    .command("list")
    .argument("<slug>", "page slug")
    .description("list tags on a page")
    .addHelpText(
      "after",
      `
Examples:
  ebrain tag list docs/api
`,
    )
    .action(async (slug: string) => {
      await withRepo(program, async (repo) => {
        const tags = await repo.tags(slug);
        print(program, tags);
      });
    });

  addDryRun(
    tagCmd
      .command("add")
      .argument("<slug>", "page slug")
      .argument("<tag>", "tag to add")
      .description("add a tag to a page (idempotent)")
      .addHelpText(
        "after",
        `
Examples:
  ebrain tag add docs/api rest
  ebrain tag add docs/api rest --dry-run
`,
      ),
  ).action(async (slug: string, tag: string, opts: { dryRun?: boolean }) => {
    if (isDryRun(opts)) {
      print(program, { dryRun: true, action: "tag-add", slug, tag });
      return;
    }
    await withRepo(program, async (repo) => {
      await repo.tag(slug, tag);
      print(program, { ok: true, action: "tag-add", slug, tag });
    });
  });

  addDryRun(
    tagCmd
      .command("remove")
      .argument("<slug>", "page slug")
      .argument("<tag>", "tag to remove")
      .description("remove a tag from a page")
      .addHelpText(
        "after",
        `
Examples:
  ebrain tag remove docs/api outdated
  ebrain tag remove docs/api outdated --dry-run
`,
      ),
  ).action(async (slug: string, tag: string, opts: { dryRun?: boolean }) => {
    if (isDryRun(opts)) {
      print(program, { dryRun: true, action: "tag-remove", slug, tag });
      return;
    }
    await withRepo(program, async (repo) => {
      await repo.untag(slug, tag);
      print(program, { ok: true, action: "tag-remove", slug, tag });
    });
  });

  // -- raw (subcommands) ----------------------------------------------------

  const rawCmd = program
    .command("raw")
    .description("manage raw source data for a page");

  rawCmd
    .command("get")
    .argument("<slug>", "page slug")
    .option("--source <source>", "filter by source name")
    .description("read raw source data for a page")
    .addHelpText(
      "after",
      `
Examples:
  ebrain raw get ingest/report
  ebrain raw get ingest/report --source crm
`,
    )
    .action(async (slug: string, opts: { source?: string }) => {
      await withRepo(program, async (repo) => {
        const rows = await repo.readRaw(slug, opts.source);
        print(program, rows);
      });
    });

  addDryRun(
    rawCmd
      .command("set")
      .argument("<slug>", "page slug")
      .requiredOption("--source <source>", "source name")
      .option("--data <json>", "JSON string")
      .option("--stdin", "read JSON from stdin", false)
      .description("write raw source data for a page")
      .addHelpText(
        "after",
        `
Examples:
  ebrain raw set ingest/report --source crm --data '{"rev": 1000}'
  echo '{"rev": 1000}' | ebrain raw set ingest/report --source crm --stdin
  ebrain raw set ingest/report --source crm --data '{"rev": 1000}' --dry-run
`,
      ),
  ).action(
    async (
      slug: string,
      opts: {
        source: string;
        data?: string;
        stdin?: boolean;
        dryRun?: boolean;
      },
    ) => {
      let data: unknown;
      if (opts.data) {
        data = JSON.parse(opts.data);
      } else if (opts.stdin) {
        const raw = await readMaybeStdin();
        if (!raw?.trim()) throw new Error("empty stdin — pipe JSON");
        data = JSON.parse(raw);
      } else {
        throw new Error("provide --data <json> or --stdin");
      }

      if (isDryRun(opts)) {
        print(program, {
          dryRun: true,
          action: "raw-set",
          slug,
          source: opts.source,
        });
        return;
      }

      await withRepo(program, async (repo) => {
        await repo.writeRaw(slug, opts.source, data);
        print(program, {
          ok: true,
          action: "raw-set",
          slug,
          source: opts.source,
        });
      });
    },
  );

  // -- import / export ------------------------------------------------------

  addDryRun(
    program
      .command("import")
      .argument("<dir>", "directory of markdown files")
      .description("import a directory of markdown files")
      .addHelpText(
        "after",
        `
Examples:
  ebrain import ./docs
  ebrain import ./docs --dry-run
`,
      ),
  ).action(async (dir: string, opts: { dryRun?: boolean }) => {
    await withRepo(program, async (repo) => {
      const root = resolve(dir);
      const files = await collectMarkdownFiles(root);
      if (isDryRun(opts)) {
        print(program, {
          dryRun: true,
          action: "import",
          dir: root,
          filesFound: files.length,
          slugs: files.map((f) => pathToSlug(f, root)),
        });
        return;
      }

      const jsonOut = isJson(program);
      const settings = await loadSettings();
      const progress = createProgress();
      const startTime = Date.now();
      
      // Phase 1: Parse all files and collect data
      progress.start(`Scanning ${files.length} files...`);
      const fileData: Array<{
        file: string;
        slug: string;
        parsed: ReturnType<typeof parsePageMarkdown>;
        content: string;
        wikiLinks: string[];
        timelineEntries: ReturnType<typeof extractTimelineLines>;
        tags: string[];
      }> = [];
      
      for (const file of files) {
        const rawSlug = pathToSlug(file, root);
        const slug = normalizeLongSlug(rawSlug);
        const content = await readTextFile(file);
        const parsed = parsePageMarkdown(content);
        const wikiLinks = extractWikiStyleLinks(content).map(normalizeLinkSlug);
        const timelineEntries = extractTimelineLines(parsed.timeline);
        const tags = Array.isArray(parsed.frontmatter.tags)
          ? parsed.frontmatter.tags.filter((t): t is string => typeof t === "string")
          : [];
        fileData.push({ file, slug, parsed, content, wikiLinks, timelineEntries, tags });
      }
      
      // Phase 2: Write all pages first (skip embed for performance)
      // We'll batch sync all pages at the end
      progress.update(`Writing ${fileData.length} pages...`);
      const allSlugs: string[] = [];
      for (let i = 0; i < fileData.length; i++) {
        const { slug, parsed } = fileData[i]!;
        if (!jsonOut && i % 10 === 0) {
          progress.update(`Writing pages... ${i + 1}/${fileData.length}`);
        }
        await repo.putPage({
          slug,
          type: String(parsed.frontmatter.type ?? inferTypeFromSlug(slug)),
          title: String(parsed.frontmatter.title ?? slugToTitle(slug)),
          compiledTruth: parsed.compiledTruth,
          timeline: parsed.timeline,
          frontmatter: parsed.frontmatter,
        }, true); // skipEmbed: true for performance
        allSlugs.push(slug);
      }
      
      // Phase 3: Parallel entity extraction (main optimization)
      progress.update("Extracting entities...");
      const BATCH_SIZE = 10;
      const entityResults = new Map<string, Awaited<ReturnType<typeof extractRelations>>>();
      
      if (settings.llm.baseURL) {
        for (let i = 0; i < fileData.length; i += BATCH_SIZE) {
          const batch = fileData.slice(i, i + BATCH_SIZE).filter(d => d.tags.length === 0);
          if (!jsonOut) {
            progress.update(`Extracting entities... ${Math.min(i + BATCH_SIZE, fileData.length)}/${fileData.length}`);
          }
          const batchPromises = batch.map(async ({ slug, content }) => {
            const relations = await extractRelations(content, settings.llm);
            return { slug, relations };
          });
          const results = await Promise.all(batchPromises);
          for (const { slug, relations } of results) {
            entityResults.set(slug, relations);
          }
        }
      }
      
      // Phase 4: Write links, tags, timeline, and entity pages
      progress.update("Creating links and timeline...");
      let linkCount = 0;
      let timelineCount = 0;
      let entityCount = 0;
      
      // Collect timeline entries for batch insert
      const allTimelineEntries: Array<{
        pageSlug: string;
        date: string;
        source: string;
        summary: string;
        detail: string;
      }> = [];
      
      for (const { slug, wikiLinks, timelineEntries, tags, content } of fileData) {
        // Wiki links
        for (const link of wikiLinks) {
          await repo.link(slug, link, "import");
          linkCount++;
        }
        
        // Collect timeline entries for batch insert
        for (const entry of timelineEntries) {
          allTimelineEntries.push({
            pageSlug: slug,
            date: entry.date,
            source: entry.source,
            summary: entry.summary,
            detail: "",
          });
          timelineCount++;
        }
        
        // Tags
        for (const tag of tags) {
          await repo.tag(slug, tag);
        }
        
        // Entity links from parallel extraction
        const relations = entityResults.get(slug);
        if (relations && relations.length > 0) {
          const highConfidence = relations.filter(r => r.confidence >= 0.6);
          for (const r of highConfidence) {
            const fromCandidate = entityToSlug(r.from.name, r.from.type);
            const toCandidate = entityToSlug(r.to.name, r.to.type);
            const fromSlug = await repo.findSimilarSlug(fromCandidate, r.from.name);
            const toSlug = await repo.findSimilarSlug(toCandidate, r.to.name);
            
            const c1 = await repo.ensureEntityPage(fromSlug, r.from.type, r.from.name, r.relation, r.context, slug);
            const c2 = await repo.ensureEntityPage(toSlug, r.to.type, r.to.name, r.relation, r.context, slug);
            if (c1) entityCount++;
            if (c2) entityCount++;
            
            await repo.link(fromSlug, toSlug, `[${r.relation}] ${r.context}`);
            await repo.link(slug, fromSlug, `Mentions ${r.from.name}`);
            await repo.link(slug, toSlug, `Mentions ${r.to.name}`);
            linkCount += 3;
          }
        }
      }
      
      // Batch insert all timeline entries
      if (allTimelineEntries.length > 0) {
        await repo.timelineAddBatch(allTimelineEntries);
      }
      
      // Batch sync all pages to search index
      progress.update(`Indexing ${allSlugs.length} pages...`);
      await repo.embedAll();
      
      const duration = formatDuration(Date.now() - startTime);
      progress.succeed(`${files.length} files imported, ${entityCount} entities, ${linkCount} links (${duration})`);
      
      print(program, {
        importedFiles: files.length,
        pages: fileData.length,
        links: linkCount,
        timelineEntries: timelineCount,
        entities: entityCount,
      });
    });
  });

  program
    .command("export")
    .option("--dir <dir>", "output directory", resolve(process.cwd(), "export"))
    .description("export all pages as markdown files")
    .addHelpText(
      "after",
      `
Examples:
  ebrain export
  ebrain export --dir ./backup
`,
    )
    .action(async (opts: { dir: string }) => {
      await withRepo(program, async (repo) => {
        const dir = resolve(opts.dir);
        await ensureDir(dir);
        const pages = await repo.listPages({ limit: 100000 });
        const jsonOut = isJson(program);
        for (let i = 0; i < pages.length; i += 1) {
          const page = pages[i]!;
          progress("export " + page.slug, i + 1, pages.length, jsonOut);
          const tags = await repo.tags(page.slug);
          const fm = {
            ...page.frontmatter,
            type: page.type,
            title: page.title,
          };
          if (tags.length > 0)
            (fm as Record<string, unknown>).tags = tags;
          const md = renderPageMarkdown(fm, page.compiledTruth, page.timeline);
          await writeTextFile(slugToPath(page.slug, dir), md);
        }
        print(program, { exported: pages.length, dir });
      });
    });

  // -- ingest ---------------------------------------------------------------

  addDryRun(
    program
      .command("ingest")
      .argument("[file]", "file path to ingest (omit for stdin)")
      .option("--type <type>", "source type", "doc")
      .option("--stdin", "read from stdin", false)
      .description("ingest a file as a new page (under ingest/<name>)")
      .addHelpText(
        "after",
        `
Examples:
  ebrain ingest report.pdf --type pdf
  cat article.md | ebrain ingest --stdin --type article
  ebrain ingest report.pdf --type pdf --dry-run
`,
      ),
  ).action(
    async (
      file: string | undefined,
      opts: { type?: string; stdin?: boolean; dryRun?: boolean },
    ) => {
      let content: string;
      let fileName: string;

      if (file) {
        const fullPath = resolve(file);
        if (!(await fileExists(fullPath))) {
          throw new Error(`file not found: ${file}`);
        }
        content = await readTextFile(fullPath);
        fileName = basename(fullPath);
      } else if (opts.stdin) {
        const raw = await readMaybeStdin();
        if (!raw?.trim()) throw new Error("empty stdin — pipe content");
        content = raw;
        fileName = "stdin";
      } else {
        throw new Error("provide <file> or --stdin");
      }

      const slug = `ingest/${fileName.replace(/\.[^.]+$/, "")}`;
      const type = opts.type ?? "doc";

      if (isDryRun(opts)) {
        print(program, {
          dryRun: true,
          action: "ingest",
          slug,
          type,
          contentLength: content.length,
        });
        return;
      }

      await withRepo(program, async (repo) => {
        await repo.putPage({
          slug,
          type,
          title: slugToTitle(slug),
          compiledTruth: content,
          timeline: "",
          frontmatter: {
            sourceFile: resolve(fileName),
            sourceType: type,
          },
        });
        await repo.timelineAdd({
          pageSlug: slug,
          date: new Date().toISOString().slice(0, 10),
          source: type,
          summary: `Ingested file ${fileName}`,
          detail: "",
        });
        await applyEntityLinks(
          repo,
          slug,
          content,
          isJson(program),
        );
        print(program, { ok: true, action: "ingest", slug });
      });
    },
  );

  // -- embed ----------------------------------------------------------------

  addDryRun(
    program
      .command("embed")
      .argument("[slug]", "page slug (omit with --all)")
      .option("--all", "embed all pages")
      .description("refresh page embedding(s)")
      .addHelpText(
        "after",
        `
Examples:
  ebrain embed docs/api
  ebrain embed --all
  ebrain embed --all --dry-run
`,
      ),
  ).action(
    async (
      slug: string | undefined,
      opts: { all?: boolean; dryRun?: boolean },
    ) => {
      if (opts.all) {
        if (isDryRun(opts)) {
          await withRepo(program, async (repo) => {
            const pages = await repo.listPages({ limit: 100000 });
            print(program, {
              dryRun: true,
              action: "embed",
              mode: "all",
              pagesFound: pages.length,
            });
          });
          return;
        }
        await withRepo(program, async (repo) => {
          const jsonOut = isJson(program);
          const pages = await repo.listPages({ limit: 100000 });
          let count = 0;
          for (const page of pages) {
            count += 1;
            progress("embed " + page.slug, count, pages.length, jsonOut);
            await repo.syncPageToSearch(page.slug);
          }
          print(program, { embedded: count, mode: "all" });
        });
        return;
      }
      if (!slug) {
        throw new Error("provide <slug> or --all");
      }
      if (isDryRun(opts)) {
        print(program, { dryRun: true, action: "embed", slug });
        return;
      }
      await withRepo(program, async (repo) => {
        await repo.syncPageToSearch(slug);
        print(program, { embedded: 1, slug });
      });
    },
  );

  // -- init / stats ---------------------------------------------------------

  program
    .command("init")
    .description("initialize the ebrain database")
    .addHelpText(
      "after",
      `
Examples:
  ebrain init
`,
    )
    .action(async () => {
      await withRepo(program, async () => {
        print(program, {
          ok: true,
          dbPath:
            program.opts().db ?? (await loadSettings()).dbPath,
        });
      });
    });

  program
    .command("stats")
    .description("show knowledge base statistics")
    .addHelpText(
      "after",
      `
Examples:
  ebrain stats
  ebrain stats --json
`,
    )
    .action(async () => {
      await withRepo(program, async (repo) => {
        print(program, await repo.stats());
      });
    });

  // Register compile and smart-ingest commands
  registerCompileCommands(program);

  // Register graph command
  registerGraphCommand(program);

  // -- serve / tools-json ---------------------------------------------------

  program
    .command("serve")
    .description("start MCP server over stdio (for AI tool integration)")
    .addHelpText(
      "after",
      `
Examples:
  ebrain serve
`,
    )
    .action(async () => {
      const { startMcpServer } = await import("../mcp/server");
      const dbPath = String(program.opts().db);
      await startMcpServer(dbPath);
    });

  program
    .command("tools-json")
    .description("print MCP tools discovery JSON")
    .action(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { TOOL_MANIFEST } = require("../mcp/server");
      console.log(JSON.stringify({ tools: TOOL_MANIFEST }, null, 2));
    });

  // -- legacy aliases (backward compat, hidden) -----------------------------





  return program;
}

// ---------------------------------------------------------------------------
// Repo / output helpers
// ---------------------------------------------------------------------------

async function withRepo(
  program: Command,
  callback: (repo: BrainRepository) => Promise<void>,
): Promise<void> {
  const settings = await loadSettings();
  const cliDb = program.opts().db;
  const dbPath = cliDb ?? settings.dbPath;
  const db = await BrainDb.connect(dbPath, settings);
  const repo = new BrainRepository(db);
  await callback(repo);
  // CLI 短生命周期应用：强制退出绕过 seekdb native 模块的 cleanup bug
  process.exit(0);
}

function print(program: Command, payload: unknown): void {
  if (isJson(program)) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (typeof payload === "string") {
    console.log(payload);
    return;
  }
  console.log(formatHuman(payload));
}

function isJson(program: Command): boolean {
  return Boolean(program.opts().json);
}

function formatHuman(payload: unknown): string {
  if (Array.isArray(payload)) {
    return payload
      .map((item) =>
        typeof item === "string"
          ? `- ${item}`
          : `- ${JSON.stringify(item)}`,
      )
      .join("\n");
  }
  return JSON.stringify(payload, null, 2);
}

function normalizeLinkSlug(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\.\.\//g, "")
    .replace(/\.md$/, "");
}

// ---------------------------------------------------------------------------
// LLM Answer Generation
// ---------------------------------------------------------------------------

interface ContextPage {
  slug: string;
  title: string;
  excerpt: string;
}

async function generateAnswerFromExcerpts(
  question: string,
  pages: ContextPage[],
  llm: ResolvedLLM,
): Promise<string> {
  const apiKey = llm.apiKey || process.env[llm.apiKeyEnv] || "";
  if (!apiKey) {
    return "Error: LLM API key not configured.";
  }

  // Build context from page excerpts
  const context = pages
    .map((p, i) => {
      return `## Source ${i + 1}: ${p.title}\n**Slug:** ${p.slug}\n\n${p.excerpt}`;
    })
    .join("\n\n---\n\n");

  const prompt = `You are answering a question based on the provided knowledge base context.

## Question
${question}

## Context from Knowledge Base
${context || "(No relevant pages found)"}

## Instructions
- Answer the question based ONLY on the provided context
- If the context doesn't contain enough information, say so
- Cite sources using markdown links like [Title](slug) when referencing specific information
- Format your answer in clean markdown
- Be concise but comprehensive

## Answer`;

  try {
    const resp = await fetch(
      llm.baseURL.endsWith("/") ? llm.baseURL + "chat/completions" : llm.baseURL + "/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: llm.model,
          messages: [
            {
              role: "system",
              content: "You are a helpful assistant that answers questions based on a knowledge base. Always cite your sources.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 2048,
        }),
      },
    );

    if (!resp.ok) {
      const text = await resp.text();
      return `Error: LLM API failed (${resp.status}): ${text.slice(0, 200)}`;
    }

    const data = await resp.json();
    return data.choices?.[0]?.message?.content || "(No answer generated)";
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `Error: ${msg}`;
  }
}
