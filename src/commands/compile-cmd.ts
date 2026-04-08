import { Command } from "commander";
import { basename } from "node:path";
import { normalizeLongSlug, slugify } from "../config";
import { readMaybeStdin, readTextFile } from "../markdown/io";
import { loadSettings } from "../settings";
import { BrainRepository } from "../repositories/brain-repo";
import { BrainDb } from "../db/client";
import { createProgress, formatDuration } from "../utils/progress";

function isDryRun(opts: Record<string, unknown>): boolean {
  return Boolean(opts.dryRun);
}

async function resolveInput(
  fileOpt: string | undefined,
  stdin: boolean,
): Promise<string> {
  if (fileOpt) return readTextFile(fileOpt);
  return readMaybeStdin().then((s) => s ?? "");
}

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
  process.exit(0);
}

function print(program: Command, payload: unknown): void {
  if (program.opts().json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

export function registerCompileCommands(program: Command): void {
  // -- compile (Smart Compilation)
  program
    .command("compile")
    .argument("<slug>", "page slug")
    .argument("<info>", "new information to compile")
    .option("--source <source>", "source of information", "user")
    .option("--date <date>", "date of information (YYYY-MM-DD)")
    .option("--dry-run", "preview changes without executing", false)
    .description("Intelligently compile new information into a page's compiled truth")
    .addHelpText(
      "after",
      `
Examples:
  ebrain compile companies/river-ai "River AI closed Series A funding" --source meeting_notes
  ebrain compile people/john "John joined as CEO last month" --date 2025-03-01
`,
    )
    .action(async (slug: string, info: string, opts: { source?: string; date?: string; dryRun?: boolean }) => {
      if (isDryRun(opts)) {
        print(program, {
          dryRun: true,
          action: "compile",
          slug,
          info,
          source: opts.source ?? "user",
          date: opts.date ?? new Date().toISOString().slice(0, 10),
        });
        return;
      }

      await withRepo(program, async (repo) => {
        const settings = await loadSettings();
        const progress = createProgress();
        
        progress.start(`Compiling into ${slug}...`);
        const startTime = Date.now();
        
        const result = await repo.compilePage(
          slug,
          info,
          opts.source ?? "user",
          opts.date ?? new Date().toISOString().slice(0, 10),
          settings.llm,
        );
        
        const duration = formatDuration(Date.now() - startTime);
        
        if (result.changed) {
          progress.succeed(`${result.changeSummary} (${duration})`);
        } else {
          progress.stop();
          process.stderr.write(`No changes made (${duration})\n`);
        }
        
        print(program, {
          ok: true,
          action: "compile",
          slug,
          changed: result.changed,
          changeType: result.changeType,
          changeSummary: result.changeSummary,
          timelineEntriesAdded: result.timelineEntries.length,
          confidence: result.confidence,
        });
      });
    });

  // -- smart-ingest (Full Intelligent Ingestion)
  program
    .command("smart-ingest")
    .argument("[slug]", "page slug (optional; auto-generated if omitted)")
    .option("--file <path>", "read content from file")
    .option("--stdin", "read content from stdin", false)
    .option("--type <type>", "page type", "note")
    .option("--title <title>", "page title")
    .option("--source <source>", "source identifier", "ingest")
    .option("--dry-run", "preview changes without executing", false)
    .description("Full intelligent ingestion: compile truth, extract timeline, create entity links")
    .addHelpText(
      "after",
      `
Examples:
  ebrain smart-ingest --file meeting.md --type meeting --source "meeting_notes"
  ebrain smart-ingest companies/river-ai --file report.md --type company
  cat article.md | ebrain smart-ingest --stdin --type article
`,
    )
    .action(async (slug: string | undefined, opts: { file?: string; stdin?: boolean; type?: string; title?: string; source?: string; dryRun?: boolean }) => {
      const input = await resolveInput(opts.file, opts.stdin ?? false);
      if (!input.trim()) {
        throw new Error("empty input — provide --file <path>, --stdin, or pipe content");
      }

      let finalSlug = slug;
      if (!finalSlug) {
        if (opts.file) {
          const fileName = basename(opts.file).replace(/\.[^.]+$/i, "");
          finalSlug = normalizeLongSlug(slugify(fileName));
        } else if (opts.title) {
          finalSlug = normalizeLongSlug(slugify(opts.title));
        } else {
          const timestamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
          finalSlug = `ingest/${timestamp}`;
        }
      }

      if (isDryRun(opts)) {
        print(program, {
          dryRun: true,
          action: "smart-ingest",
          slug: finalSlug,
          type: opts.type ?? "note",
          source: opts.source ?? "ingest",
          contentLength: input.length,
        });
        return;
      }

      await withRepo(program, async (repo) => {
        const settings = await loadSettings();
        const progress = createProgress();
        const startTime = Date.now();
        
        progress.start(`Ingesting into ${finalSlug}...`);
        
        const result = await repo.ingestContent(
          finalSlug,
          input,
          opts.source ?? "ingest",
          opts.type ?? "note",
          settings.llm,
        );
        
        const duration = formatDuration(Date.now() - startTime);
        
        const parts = [];
        if (result.compileResult.changed) parts.push(result.compileResult.changeSummary);
        if (result.timelineResult.entries.length > 0) parts.push(`${result.timelineResult.entries.length} timeline entries`);
        
        if (parts.length > 0) {
          progress.succeed(`${parts.join(", ")} (${duration})`);
        } else {
          progress.stop();
          process.stderr.write(`No changes made (${duration})\n`);
        }
        
        print(program, {
          ok: true,
          action: "smart-ingest",
          slug: result.page.slug,
          compile: {
            changed: result.compileResult.changed,
            changeType: result.compileResult.changeType,
            changeSummary: result.compileResult.changeSummary,
            confidence: result.compileResult.confidence,
          },
          timeline: {
            entriesAdded: result.timelineResult.entries.length,
            confidence: result.timelineResult.confidence,
          },
          updatedAt: result.page.updatedAt,
        });
      });
    });
}