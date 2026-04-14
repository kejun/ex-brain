import { basename, resolve } from "node:path";
import { readFileSync } from "node:fs";
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
import {
  success,
  error as cliError,
  warning,
  info,
  step,
  subItem,
  keyValue,
  header,
  createSpinner,
  formatCount,
  type ProgressSpinner,
} from "../utils/cli-output";

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
      warning(`LLM not configured, skipping entity extraction for ${sourceSlug}`);
    }
    return { created: 0, linked: 0 };
  }

  const spinner = createSpinner();
  if (!json) {
    spinner.start(`Extracting entities from ${sourceSlug}...`);
  }

  const startTime = Date.now();
  let relations;
  try {
    relations = await extractRelations(content, settings.llm);
  } catch (err) {
    if (!json) {
      spinner.fail(`Entity extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { created: 0, linked: 0 };
  }
  
  // Filter by confidence
  const confidenceThreshold = settings.extraction.confidenceThreshold;
  const highConfidence = relations.filter((r) => r.confidence >= confidenceThreshold);
  const ignoredCount = relations.length - highConfidence.length;
  
  if (highConfidence.length === 0) {
    if (!json) {
      if (relations.length > 0) {
        spinner.warn(`Found ${relations.length} entities but all below confidence threshold (${confidenceThreshold})`);
      } else {
        spinner.warn(`No entities found in content`);
      }
    }
    return { created: 0, linked: 0 };
  }

  let created = 0;
  let linked = 0;
  const details: string[] = [];

  for (const r of highConfidence) {
    // 1. Resolve entity slugs (disambiguation)
    const fromCandidate = entityToSlug(r.from.name, r.from.type);
    const toCandidate = entityToSlug(r.to.name, r.to.type);
    
    const fromSlug = await repo.findSimilarSlug(fromCandidate, r.from.name);
    const toSlug = await repo.findSimilarSlug(toCandidate, r.to.name);

    // 2. Ensure entity pages exist
    const c1 = await repo.ensureEntityPage(fromSlug, r.from.type, r.from.name, r.relation, r.context, sourceSlug);
    const c2 = await repo.ensureEntityPage(toSlug, r.to.type, r.to.name, r.relation, r.context, sourceSlug);
    if (c1) { created += 1; details.push(`Created: ${r.from.name} (${r.from.type})`); }
    if (c2) { created += 1; details.push(`Created: ${r.to.name} (${r.to.type})`); }

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
    const entityNames = [...new Set(highConfidence.flatMap((r) => [r.from.name, r.to.name]))];
    spinner.succeed(`Extracted ${entityNames.length} entities: ${entityNames.join(", ")}`);
    
    // Print detailed info
    subItem(`${created} entity pages created`);
    subItem(`${linked} links added`);
    if (ignoredCount > 0) {
      subItem(`${ignoredCount} low-confidence relations ignored`);
    }
    subItem(`Completed in ${duration}`);
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
  const pkgPath = new URL("../../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const program = new Command("ebrain")
    .description("Personal knowledge base CLI powered by seekdb")
    .version(pkg.version, "-V, --version", "output the version number")
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
        const jsonOut = isJson(program);
        const spinner = createSpinner();
        const startTime = Date.now();
        
        if (!jsonOut) {
          header(`Put: ${finalSlug}`);
          spinner.start(`Creating/updating page...`);
        }
        
        const page = await repo.putPage({
          slug: finalSlug,
          type,
          title,
          compiledTruth: parsed.compiledTruth,
          timeline: parsed.timeline,
          frontmatter: parsed.frontmatter,
        });
        
        if (!jsonOut) {
          spinner.succeed(`Page saved: ${page.slug}`);
          keyValue("Title", title);
          keyValue("Type", type);
          keyValue("Content length", `${parsed.compiledTruth.length} chars`);
        }
        
        await applyEntityLinks(
          repo,
          finalSlug,
          parsed.compiledTruth,
          jsonOut,
        );
        
        if (!jsonOut) {
          const duration = formatDuration(Date.now() - startTime);
          success(`Operation completed in ${duration}`);
        }
        
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
      const jsonOut = isJson(program);
      const spinner = createSpinner();
      
      if (!jsonOut) {
        header(`Delete: ${slug}`);
        spinner.start(`Deleting page and related data...`);
      }
      
      await repo.deletePage(slug);
      
      if (!jsonOut) {
        spinner.succeed(`Page deleted: ${slug}`);
      }
      
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
        
        // If --llm flag, generate answer based on multi-layer context
        if (opts.llm) {
          const settings = await loadSettings();
          if (!settings.llm.baseURL) {
            print(program, { error: "LLM not configured. Set llm.baseURL in settings." });
            return;
          }
          
          const progress = createProgress();
          progress.start("Searching knowledge base...");
          
          const contextLimit = Number(opts.contextLimit ?? 5);
          const topHits = hits.slice(0, contextLimit);
          
          if (topHits.length === 0) {
            progress.stop();
            process.stderr.write("No relevant pages found.\n");
            print(program, { answer: "No relevant information found in the knowledge base.", sources: [] });
            return;
          }
          
          // Collect multi-layer context (primary + raw data + linked pages scored by relevance)
          // ~100KB char budget ≈ 25K tokens, safe for most models
          const MAX_CONTEXT_CHARS = 100_000;
          const ctxStart = Date.now();
          progress.update(`Loading page content...`);
          const { sections, totalChars, stats } = await collectContextForLLM(repo, topHits, question, MAX_CONTEXT_CHARS, (stage) => {
            progress.update(`Loading ${stage}...`);
          });
          const ctxDuration = formatDuration(Date.now() - ctxStart);
          
          if (sections.length === 0) {
            progress.stop();
            process.stderr.write("No content could be loaded.\n");
            print(program, { answer: "Failed to load page content.", sources: [] });
            return;
          }
          
          progress.succeed(`Loaded ${stats.primaryPages} page(s), ${stats.rawDocs} raw doc(s), ${stats.linkedPages} linked page(s) (${ctxDuration})`);
          const startTime = Date.now();
          
          const { answer, ok } = await generateAnswerWithStream(question, sections, stats, settings.llm);
          
          if (!ok) {
            // If streaming failed, answer contains the error message
            console.log(answer);
            return;
          }
          
          const duration = formatDuration(Date.now() - startTime);
          
          // Show sources breakdown
          console.log("\n---\n**Sources:**\n");
          for (let i = 0; i < sections.length; i++) {
            const s = sections[i];
            const icon = s.type === 'primary' ? '📄' : s.type === 'raw_data' ? '📎' : '🔗';
            console.log(`${icon} ${i + 1}. [[${s.slug}|${s.title}]] — ${s.label} (${(s.content.length / 1024).toFixed(1)}KB)`);
          }
          console.log(`\n*Context: ${stats.primaryPages} page(s), ${stats.rawDocs} raw doc(s), ${stats.linkedPages} linked page(s)*`);
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
      .option("--skip-index", "skip vector indexing (useful if seekdb crashes)")
      .addHelpText(
        "after",
        `
Examples:
  ebrain import ./docs
  ebrain import ./docs --dry-run
  ebrain import ./docs --skip-index  # skip vector indexing
`,
      ),
  ).action(async (dir: string, opts: { dryRun?: boolean; skipIndex?: boolean }) => {
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
      const spinner = createSpinner();
      const startTime = Date.now();
      
      if (!jsonOut) {
        header(`Import: ${root}`);
      }
      
      // Phase 1: Parse all files and collect data
      if (!jsonOut) {
        spinner.start(`Scanning ${files.length} files...`);
      }
      
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
      
      if (!jsonOut) {
        spinner.succeed(`Found ${files.length} markdown files`);
      }
      
      // Phase 2: Write all pages first (skip embed for performance)
      if (!jsonOut) {
        spinner.start(`Writing ${fileData.length} pages to database...`);
      }
      
      const allSlugs: string[] = [];
      const writeErrors: string[] = [];
      
      for (let i = 0; i < fileData.length; i++) {
        const { slug, parsed } = fileData[i]!;
        if (!jsonOut && i % 20 === 0) {
          spinner.update(`Writing pages... ${i + 1}/${fileData.length}`);
        }
        try {
          await repo.putPage({
            slug,
            type: String(parsed.frontmatter.type ?? inferTypeFromSlug(slug)),
            title: String(parsed.frontmatter.title ?? slugToTitle(slug)),
            compiledTruth: parsed.compiledTruth,
            timeline: parsed.timeline,
            frontmatter: parsed.frontmatter,
          }, true); // skipEmbed: true for performance
          allSlugs.push(slug);
        } catch (err) {
          writeErrors.push(`${slug}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      
      if (!jsonOut) {
        spinner.succeed(`Wrote ${allSlugs.length} pages to database`);
        if (writeErrors.length > 0) {
          warning(`${writeErrors.length} pages failed to write`);
          for (const e of writeErrors.slice(0, 3)) {
            subItem(e);
          }
          if (writeErrors.length > 3) {
            subItem(`... and ${writeErrors.length - 3} more`);
          }
        }
      }
      
      // Phase 3: Parallel entity extraction (main optimization)
      const BATCH_SIZE = 10;
      const entityResults = new Map<string, Awaited<ReturnType<typeof extractRelations>>>();
      
      if (settings.llm.baseURL) {
        if (!jsonOut) {
          spinner.start(`Extracting entities with LLM...`);
        }
        
        for (let i = 0; i < fileData.length; i += BATCH_SIZE) {
          const batch = fileData.slice(i, i + BATCH_SIZE);
          if (!jsonOut) {
            spinner.update(`Extracting entities... ${Math.min(i + BATCH_SIZE, fileData.length)}/${fileData.length}`);
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
        
        if (!jsonOut) {
          spinner.succeed(`Entity extraction complete`);
        }
      } else {
        if (!jsonOut) {
          warning(`LLM not configured, skipping entity extraction`);
        }
      }
      
      // Phase 4: Write links, tags, timeline, and entity pages
      if (!jsonOut) {
        spinner.start(`Creating links, tags, and timeline entries...`);
      }
      
      let linkCount = 0;
      let timelineCount = 0;
      let entityCount = 0;
      let tagCount = 0;
      
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
          tagCount++;
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
      
      if (!jsonOut) {
        spinner.succeed(`Created links, tags, and timeline`);
      }
      
      // Phase 5: Batch sync all pages to search index
      if (opts.skipIndex) {
        if (!jsonOut) {
          info(`Skipping vector indexing (--skip-index)`);
        }
      } else {
        if (!jsonOut) {
          spinner.start(`Indexing ${allSlugs.length} pages for search...`);
        }
        await repo.embedAll();
        
        if (!jsonOut) {
          spinner.succeed(`Search indexing complete`);
        }
      }
      
      const duration = formatDuration(Date.now() - startTime);
      
      if (!jsonOut) {
        // Print summary
        header("Import Summary");
        keyValue("Files imported", String(files.length));
        keyValue("Pages created", String(allSlugs.length));
        keyValue("Entities extracted", String(entityCount));
        keyValue("Links created", String(linkCount));
        keyValue("Timeline entries", String(timelineCount));
        keyValue("Tags added", String(tagCount));
        keyValue("Duration", duration);
        
        if (writeErrors.length > 0) {
          warning(`${writeErrors.length} pages had errors`);
        }
      }
      
      print(program, {
        ok: true,
        importedFiles: files.length,
        pages: allSlugs.length,
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
        const jsonOut = isJson(program);
        const spinner = createSpinner();
        const startTime = Date.now();
        
        if (!jsonOut) {
          header(`Ingest: ${fileName}`);
          spinner.start(`Creating page from file...`);
        }
        
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
        
        if (!jsonOut) {
          spinner.succeed(`Page created: ${slug}`);
          keyValue("Source file", fileName);
          keyValue("Type", type);
          keyValue("Content length", `${content.length} chars`);
        }
        
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
          jsonOut,
        );
        
        if (!jsonOut) {
          const duration = formatDuration(Date.now() - startTime);
          success(`Ingestion completed in ${duration}`);
        }
        
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
          const spinner = createSpinner();
          const startTime = Date.now();
          
          if (!jsonOut) {
            header("Embed All Pages");
            spinner.start(`Loading pages...`);
          }
          
          const pages = await repo.listPages({ limit: 100000 });
          
          if (!jsonOut) {
            spinner.update(`Embedding ${pages.length} pages...`);
          }
          
          const count = await repo.embedAll();
          
          if (!jsonOut) {
            const duration = formatDuration(Date.now() - startTime);
            spinner.succeed(`Embedded ${count} pages`);
            keyValue("Duration", duration);
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
        const jsonOut = isJson(program);
        const spinner = createSpinner();
        
        if (!jsonOut) {
          header(`Embed: ${slug}`);
          spinner.start(`Generating embedding for page...`);
        }
        
        await repo.syncPageToSearch(slug);
        
        if (!jsonOut) {
          spinner.succeed(`Page embedded: ${slug}`);
        }
        
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
        const settings = await loadSettings();
        const dbPath = program.opts().db ?? settings.dbPath;
        
        success(`Database initialized`);
        keyValue("Path", dbPath);
        
        print(program, {
          ok: true,
          dbPath,
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
        const jsonOut = isJson(program);
        const stats = await repo.stats();
        
        if (!jsonOut) {
          header("Knowledge Base Statistics");
          keyValue("Pages", String(stats.pages));
          keyValue("Links", String(stats.links));
          keyValue("Tags", String(stats.tags));
          keyValue("Timeline entries", String(stats.timelineEntries));
          keyValue("Raw data rows", String(stats.rawRows));
        }
        
        print(program, stats);
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
  
  // Gracefully close database
  // Note: seekdb SDK's InternalEmbeddedClient.close() is empty in embedded mode
  // Data may not flush properly. Use remote seekdb server for reliability.
  try {
    await db.close();
  } catch (e) {
    // Close may fail due to seekdb native bug
  }
  
  // Give seekdb extra time after close
  await new Promise((r) => setTimeout(r, 500));
  
  // CLI: force exit to bypass seekdb native cleanup segfault
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
// LLM Answer Generation — Multi-layer Context Collection
// ---------------------------------------------------------------------------

/** A single section of context for the LLM prompt. */
interface ContextSection {
  type: 'primary' | 'raw_data' | 'linked';
  slug: string;
  title: string;
  content: string;
  /** Human-readable label like "原始文档 (crm)" or "关联页面: projects/alpha". */
  label: string;
}

/**
 * Collect multi-layer context for LLM answer generation.
 * 
 * Layers (in priority order):
 * 1. Primary: compiledTruth + timeline of each hit page
 * 2. Raw data: original documents stored via raw.set
 * 3. Linked pages: compiledTruth of pages linked to/from hit pages
 * 
 * Budget is enforced via total character limit.
 */
async function collectContextForLLM(
  repo: BrainRepository,
  hits: Array<{ slug: string; title: string; score: number }>,
  question: string,
  maxChars: number,
  onProgress?: (stage: string) => void,
): Promise<{ sections: ContextSection[]; totalChars: number; stats: ContextStats }> {
  const sections: ContextSection[] = [];
  let totalChars = 0;
  const stats: ContextStats = {
    primaryPages: 0,
    rawDocs: 0,
    linkedPages: 0,
    skippedChars: 0,
  };

  const seenSlugs = new Set<string>();

  function addSection(section: ContextSection): boolean {
    if (seenSlugs.has(`${section.type}:${section.slug}:${section.label}`)) {
      return false;
    }
    const budget = maxChars - totalChars;
    if (section.content.length > budget && sections.length > 0) {
      // Truncate to fit budget
      section.content = section.content.slice(0, budget - 20) + '\n...[truncated]';
      stats.skippedChars += section.content.length - budget;
    }
    if (section.content.length > 0) {
      sections.push(section);
      totalChars += section.content.length;
      seenSlugs.add(`${section.type}:${section.slug}:${section.label}`);
      return true;
    }
    return false;
  }

  // Cache pages fetched in Layer 1 to avoid redundant DB calls in Layer 3
  const pageCache = new Map<string, NonNullable<Awaited<ReturnType<typeof repo.getPage>>>>();

  // Layer 1: Primary pages (compiledTruth + timeline)
  onProgress?.('page content');
  for (const hit of hits) {
    const page = await repo.getPage(hit.slug);
    if (!page) continue;
    pageCache.set(hit.slug, page);

    const parts: string[] = [];
    if (page.compiledTruth?.trim()) {
      parts.push(page.compiledTruth.trim());
    }
    const tl = page.timeline?.trim();
    if (tl) {
      parts.push(`## 时间线\n${tl}`);
    }

    if (parts.length > 0) {
      addSection({
        type: 'primary',
        slug: page.slug,
        title: page.title,
        content: parts.join('\n\n'),
        label: `页面正文`,
      });
      stats.primaryPages++;
    }
  }

  // Layer 2: Raw data (original documents)
  onProgress?.('raw documents');
  for (const hit of hits) {
    try {
      const rawRows = await repo.readRaw(hit.slug) as Array<{ source: string; data: unknown; fetchedAt?: string }>;
      for (const row of rawRows) {
        let rawContent = '';
        if (typeof row.data === 'string') {
          rawContent = row.data;
        } else if (typeof row.data === 'object' && row.data !== null) {
          rawContent = JSON.stringify(row.data, null, 2);
        }
        if (rawContent.trim()) {
          addSection({
            type: 'raw_data',
            slug: hit.slug,
            title: hit.title,
            content: rawContent,
            label: `原始文档 (${row.source})`,
          });
          stats.rawDocs++;
        }
      }
    } catch {
      // Raw data fetch failure is non-fatal
    }
  }

  // Layer 3: Linked pages — score using cached data + keyword matching
  // No second repo.query() call needed — reuse hits scores + keyword fallback
  onProgress?.('linked pages');
  const allLinkedSlugs = new Set<string>();
  for (const hit of hits) {
    try {
      const outLinks = await repo.outgoingLinks(hit.slug);
      outLinks.forEach(l => allLinkedSlugs.add(l.slug));
    } catch { /* ignore */ }
    try {
      const backlinkSlugs = await repo.backlinks(hit.slug);
      backlinkSlugs.forEach(s => allLinkedSlugs.add(s));
    } catch { /* ignore */ }
  }

  if (allLinkedSlugs.size > 0) {
    // Score: use semantic scores from initial hits (already cached), keyword for rest
    const semanticScoreMap = new Map(hits.map(h => [h.slug, h.score]));
    const keywordScores = new Map<string, number>();
    for (const linkedSlug of allLinkedSlugs) {
      if (semanticScoreMap.has(linkedSlug)) continue;
      // Use cached page if available, only fetch if not in cache
      const cached = pageCache.get(linkedSlug);
      if (cached) {
        const text = `${cached.title} ${cached.compiledTruth}`.slice(0, 2000);
        keywordScores.set(linkedSlug, computeKeywordRelevance(text, question));
      } else {
        const page = await repo.getPage(linkedSlug);
        if (page) {
          pageCache.set(linkedSlug, page);
          const text = `${page.title} ${page.compiledTruth}`.slice(0, 2000);
          keywordScores.set(linkedSlug, computeKeywordRelevance(text, question));
        }
      }
    }

    // Combine scores
    const scoredLinked = [...allLinkedSlugs].map(slug => ({
      slug,
      score: semanticScoreMap.get(slug) ?? keywordScores.get(slug) ?? 0,
    }));

    // Filter: only include linked pages with meaningful relevance
    const MIN_LINKED_SCORE = 0.02;
    const relevantLinked = scoredLinked
      .filter(s => s.score >= MIN_LINKED_SCORE)
      .sort((a, b) => b.score - a.score);

    // Add linked pages (already cached in pageCache, no extra fetch needed)
    for (const linked of relevantLinked) {
      if (totalChars >= maxChars) break;

      const linkedPage = pageCache.get(linked.slug);
      if (!linkedPage || !linkedPage.compiledTruth?.trim()) continue;

      const remaining = maxChars - totalChars;
      let content = linkedPage.compiledTruth.trim();
      if (content.length > remaining - 100) {
        content = content.slice(0, remaining - 100) + '\n...[truncated]';
      }

      addSection({
        type: 'linked',
        slug: linkedPage.slug,
        title: linkedPage.title,
        content,
        label: `关联页面: ${linkedPage.slug} (相关度: ${(linked.score * 100).toFixed(1)}%)`,
      });
      stats.linkedPages++;

      // Also fetch raw data for highly relevant linked pages
      if (linked.score > 0.1) {
        try {
          const rawRows = await repo.readRaw(linked.slug) as Array<{ source: string; data: unknown }>;
          for (const row of rawRows) {
            let rawContent = typeof row.data === 'string' ? row.data : JSON.stringify(row.data);
            if (rawContent.trim().length > 100) {
              const remaining2 = maxChars - totalChars;
              if (rawContent.length > remaining2 - 100) {
                rawContent = rawContent.slice(0, remaining2 - 100) + '\n...[truncated]';
              }
              addSection({
                type: 'raw_data',
                slug: linked.slug,
                title: linkedPage.title,
                content: rawContent,
                label: `原始文档 (关联: ${row.source})`,
              });
              stats.rawDocs++;
            }
          }
        } catch { /* ignore */ }
      }
    }
  }

  return { sections, totalChars, stats };
}

/**
 * Simple keyword-based relevance scoring (fallback for pages without embeddings).
 * Computes the fraction of unique meaningful characters from the question
 * that appear in the text.
 */
function computeKeywordRelevance(text: string, question: string): number {
  const STOP_CHARS = new Set('的是了在和我有你就这不人都说上个大国为到以们年会生地要主中子自实家小对多能好可很所把当');
  const questionChars = [...question]
    .filter(c => !/\s|[,，。！？、；:：""''（）()【】\[\]{}<>\/\\|~`@#$%^&*+=_-]/.test(c) && !STOP_CHARS.has(c));
  if (questionChars.length === 0) return 0;

  const uniqueChars = new Set(questionChars);
  const lower = text.toLowerCase();
  let matched = 0;
  for (const char of uniqueChars) {
    if (lower.includes(char.toLowerCase())) matched++;
  }
  return matched / uniqueChars.size;
}

interface ContextStats {
  primaryPages: number;
  rawDocs: number;
  linkedPages: number;
  skippedChars: number;
}

/**
 * Build LLM prompt from collected context sections and generate answer.
 */
async function generateAnswerWithStream(
  question: string,
  sections: ContextSection[],
  stats: ContextStats,
  llm: ResolvedLLM,
): Promise<{ answer: string; ok: boolean }> {
  const apiKey = llm.apiKey || process.env[llm.apiKeyEnv] || "";
  if (!apiKey) {
    return { answer: "Error: LLM API key not configured.", ok: false };
  }

  if (sections.length === 0) {
    return { answer: "知识库中没有找到相关内容。", ok: true };
  }

  // Build context sections with clear labels
  const contextParts: string[] = [];
  let sectionIndex = 0;

  // Group by type for cleaner output
  const primarySections = sections.filter(s => s.type === 'primary');
  const rawSections = sections.filter(s => s.type === 'raw_data');
  const linkedSections = sections.filter(s => s.type === 'linked');

  function renderSections(group: ContextSection[], header: string) {
    if (group.length === 0) return;
    contextParts.push(`## ${header}\n`);
    for (const s of group) {
      sectionIndex++;
      contextParts.push(`### [${sectionIndex}] ${s.title} — ${s.label}\n**Slug:** ${s.slug}\n\n${s.content}\n`);
    }
    contextParts.push('');
  }

  renderSections(primarySections, '页面正文');
  renderSections(rawSections, '原始文档');
  renderSections(linkedSections, '关联页面');

  const context = contextParts.join('\n');

  const prompt = `你是一个知识库助手，请根据提供的知识库内容回答问题。

## 问题
${question}

## 知识库内容

${context}

## 回答要求
- 仅基于提供的知识库内容回答，不要编造信息
- 如果知识库中没有相关信息，请明确说明
- 引用来源时使用 [[slug|标题]] 的格式
- 使用清晰的 markdown 格式
- 如果涉及时间线信息，请在回答中体现
- 区分哪些信息来自「页面正文」、哪些来自「原始文档」、哪些来自「关联页面」
- 语言与提问保持一致（中文提问用中文回答，英文提问用英文回答）

## 回答`;

  // Disable thinking/reasoning mode to reduce latency
  const disableThinking: Record<string, unknown> = {};
  // OpenAI/compatible: extra_body for thinking disable
  // DeepSeek: use extra_body to disable thinking
  // Many providers ignore unknown fields, so this is safe to always include
  const extraBody: Record<string, unknown> = {
    thinking: { type: "disabled" },
  };

  try {
    const url = llm.baseURL.endsWith("/") ? llm.baseURL + "chat/completions" : llm.baseURL + "/chat/completions";
    
    // Show thinking indicator while waiting for first token
    process.stderr.write(`\x1b[35m💭\x1b[0m \x1b[2mConnecting to ${llm.model}...\x1b[0m\n`);
    
    const resp = await fetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: llm.model,
          stream: true,
          messages: [
            {
              role: "system",
              content: "你是一个专业的知识库助手，基于提供的知识库内容准确回答问题。引用来源时使用 [[slug|标题]] 格式。回答要条理清晰，区分信息来源。",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 4096,
          ...disableThinking,
          extra_body: extraBody,
          // Also send thinking disable as top-level for providers that support it
          thinking: { type: "disabled" },
        }),
        // Abort if no response within 30s
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!resp.ok) {
      const text = await resp.text();
      // Clear the thinking indicator line
      process.stderr.write("\r\x1b[K");
      return { answer: `Error: LLM API failed (${resp.status}): ${text.slice(0, 200)}`, ok: false };
    }

    if (!resp.body) {
      process.stderr.write("\r\x1b[K");
      return { answer: "Error: No response body from LLM API.", ok: false };
    }

    // Clear thinking indicator, show streaming status
    process.stderr.write("\r\x1b[K");
    process.stderr.write(`\x1b[32m✦\x1b[0m \x1b[2mStreaming response...\x1b[0m\n`);

    // Stream the response
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let fullAnswer = "";
    let buffer = "";
    let tokenCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last incomplete line in buffer
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;

        try {
          const json = JSON.parse(trimmed.slice(6));
          const content = json.choices?.[0]?.delta?.content;
          if (content) {
            process.stdout.write(content);
            fullAnswer += content;
            tokenCount++;
          }
        } catch {
          // Skip malformed SSE data
        }
      }
    }

    // Add a newline after streaming completes
    process.stdout.write("\n");

    return { answer: fullAnswer || "(No answer generated)", ok: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { answer: `Error: ${msg}`, ok: false };
  }
}

/**
 * @deprecated Use generateAnswerWithStream instead
 */
async function generateAnswerWithContext(
  question: string,
  sections: ContextSection[],
  stats: ContextStats,
  llm: ResolvedLLM,
): Promise<string> {
  const apiKey = llm.apiKey || process.env[llm.apiKeyEnv] || "";
  if (!apiKey) {
    return "Error: LLM API key not configured.";
  }

  if (sections.length === 0) {
    return "知识库中没有找到相关内容。";
  }

  // Build context sections with clear labels
  const contextParts: string[] = [];
  let sectionIndex = 0;

  // Group by type for cleaner output
  const primarySections = sections.filter(s => s.type === 'primary');
  const rawSections = sections.filter(s => s.type === 'raw_data');
  const linkedSections = sections.filter(s => s.type === 'linked');

  function renderSections(group: ContextSection[], header: string) {
    if (group.length === 0) return;
    contextParts.push(`## ${header}\n`);
    for (const s of group) {
      sectionIndex++;
      contextParts.push(`### [${sectionIndex}] ${s.title} — ${s.label}\n**Slug:** ${s.slug}\n\n${s.content}\n`);
    }
    contextParts.push('');
  }

  renderSections(primarySections, '页面正文');
  renderSections(rawSections, '原始文档');
  renderSections(linkedSections, '关联页面');

  const context = contextParts.join('\n');

  const prompt = `你是一个知识库助手，请根据提供的知识库内容回答问题。

## 问题
${question}

## 知识库内容

${context}

## 回答要求
- 仅基于提供的知识库内容回答，不要编造信息
- 如果知识库中没有相关信息，请明确说明
- 引用来源时使用 [[slug|标题]] 的格式
- 使用清晰的 markdown 格式
- 如果涉及时间线信息，请在回答中体现
- 区分哪些信息来自「页面正文」、哪些来自「原始文档」、哪些来自「关联页面」
- 语言与提问保持一致（中文提问用中文回答，英文提问用英文回答）

## 回答`;

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
              content: "你是一个专业的知识库助手，基于提供的知识库内容准确回答问题。引用来源时使用 [[slug|标题]] 格式。回答要条理清晰，区分信息来源。",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 4096,
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
