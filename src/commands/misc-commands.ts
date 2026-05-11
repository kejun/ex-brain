import { resolve } from "node:path";
import { Command } from "commander";
import { withRepo, isJson, print, addDryRun, isDryRun } from "./shared";
import { success, warning, header, keyValue, separator, info, subItem, createSpinner } from "../utils/cli-output";
import { formatDuration } from "../utils/progress";
import { loadSettings, SETTINGS_PATH } from "../settings";
import { BrainDb } from "../db/client";
import { fileExists, ensureDir, slugToPath, writeTextFile } from "../markdown/io";
import { renderPageMarkdown } from "../markdown/parser";

export function registerExportCommand(program: Command): void {
  program
    .command("export")
    .option("--dir <dir>", "output directory", resolve(process.cwd(), "export"))
    .description("export all pages as markdown files")
    .addHelpText("after", `
Examples:
  ebrain export
  ebrain export --dir ./backup
`)
    .action(async (opts: { dir: string }) => {
      await withRepo(program, async (repo) => {
        const dir = resolve(opts.dir);
        await ensureDir(dir);
        const pages = await repo.listPages({ limit: 100000 });
        const jsonOut = isJson(program);
        for (let i = 0; i < pages.length; i += 1) {
          const page = pages[i]!;
          if (!jsonOut) process.stderr.write(`[${i + 1}/${pages.length}] export ${page.slug}\n`);
          const tags = await repo.tags(page.slug);
          const fm = { ...page.frontmatter, type: page.type, title: page.title };
          if (tags.length > 0) (fm as Record<string, unknown>).tags = tags;
          const md = renderPageMarkdown(fm, page.compiledTruth, page.timeline);
          await writeTextFile(slugToPath(page.slug, dir), md);
        }
        print(program, { exported: pages.length, dir });
      });
    });
}

export function registerEmbedCommand(program: Command): void {
  addDryRun(
    program
      .command("embed")
      .argument("[slug]", "page slug (omit with --all)")
      .option("--all", "embed all pages")
      .description("refresh page embedding(s)")
      .addHelpText("after", `
Examples:
  ebrain embed docs/api
  ebrain embed --all
  ebrain embed --all --dry-run
`),
  ).action(async (slug: string | undefined, opts: { all?: boolean; dryRun?: boolean }) => {
    if (opts.all) {
      if (isDryRun(opts)) {
        await withRepo(program, async (repo) => {
          const pages = await repo.listPages({ limit: 100000 });
          print(program, { dryRun: true, action: "embed", mode: "all", pagesFound: pages.length });
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
        if (!jsonOut) spinner.update(`Embedding ${pages.length} pages...`);
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
    if (!slug) throw new Error("provide <slug> or --all");
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
      if (!jsonOut) spinner.succeed(`Page embedded: ${slug}`);
      print(program, { embedded: 1, slug });
    });
  });
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("initialize ebrain: create config, database, and show setup guide")
    .addHelpText("after", `
Examples:
  ebrain init
  ebrain init --db ./my.db
`)
    .action(async () => {
      const jsonOut = isJson(program);
      const settings = await loadSettings();
      const cliDb = program.opts().db;
      const dbPath = cliDb ?? settings.dbPath;

      if (!jsonOut) header("ebrain init");

      const { createDefaultSettings } = await import("../settings");
      const settingsCreated = await createDefaultSettings();

      if (!jsonOut) {
        if (settingsCreated) success(`Created config: ${SETTINGS_PATH}`);
        else success(`Config already exists: ${SETTINGS_PATH}`);
      }

      const dbExists = await fileExists(dbPath);
      let dbInitialized = false;

      if (dbExists) {
        if (!jsonOut) success(`Database already exists: ${dbPath}`);
        dbInitialized = true;
      } else {
        try {
          const db = await BrainDb.connect(dbPath, settings, { skipCollection: true });
          await db.close();
          await new Promise((r) => setTimeout(r, 200));
          dbInitialized = true;
          if (!jsonOut) success(`Database initialized: ${dbPath}`);
        } catch {
          if (!jsonOut) warning(`Database will be auto-created on first use`);
        }
      }

      if (!jsonOut) {
        console.log("");
        separator();
        info("Quick Start Guide");
        console.log("");
        subItem("1. Configure LLM (for AI queries):", 0);
        subItem(`   Edit ${SETTINGS_PATH}`, 4);
        subItem(`   Set llm.baseURL to your OpenAI-compatible API endpoint`, 4);
        subItem(`   Set llm.apiKey or export DASHSCOPE_API_KEY`, 4);
        console.log("");
        subItem("2. Add your first page:", 0);
        subItem("   echo '# Hello' | ebrain put hello --stdin", 4);
        console.log("");
        subItem("3. Import a directory of markdown files:", 0);
        subItem("   ebrain import ./docs", 4);
        console.log("");
        subItem("4. Query with AI:", 0);
        subItem('   ebrain query "What did we ship in Q4?" --llm', 4);
        console.log("");
        subItem("5. Visualize your knowledge graph:", 0);
        subItem("   ebrain graph", 4);
        console.log("");
        separator();
      }

      print(program, { ok: true, settingsPath: SETTINGS_PATH, settingsCreated, dbPath, dbInitialized });
      process.exit(0);
    });
}

export function registerStatsCommand(program: Command): void {
  program
    .command("stats")
    .description("show knowledge base statistics")
    .addHelpText("after", `
Examples:
  ebrain stats
  ebrain stats --json
`)
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
}

export function registerConfigCommand(program: Command): void {
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
          hasApiKey: !!settings.embed.apiKey || !!process.env[settings.embed.apiKeyEnv],
        },
        llm: {
          baseURL: settings.llm.baseURL || "(not configured)",
          model: settings.llm.model,
          hasApiKey: !!settings.llm.apiKey || !!process.env[settings.llm.apiKeyEnv],
        },
      });
    });
}

export function registerServeCommand(program: Command): void {
  program
    .command("serve")
    .description("start MCP server over stdio (for AI tool integration)")
    .addHelpText("after", `
Examples:
  ebrain serve
`)
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
}
