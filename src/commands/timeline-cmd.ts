import { Command } from "commander";
import { loadSettings } from "../settings";
import { addDryRun, isDryRun, withRepo, isJson, print } from "./shared";
import { createProgress, formatDuration } from "../utils/progress";

export function registerTimelineCommand(program: Command): void {
  const timelineCmd = program
    .command("timeline")
    .description("manage timeline entries");

  // timeline list
  timelineCmd
    .command("list")
    .argument("<slug>", "page slug")
    .option("--limit <number>", "max results", "50")
    .description("list timeline entries for a page")
    .addHelpText("after", `
Examples:
  ebrain timeline list projects/alpha
  ebrain timeline list projects/alpha --limit 10
`)
    .action(async (slug: string, opts: Record<string, string>) => {
      await withRepo(program, async (repo) => {
        const rows = await repo.timeline(slug, Number(opts.limit ?? 50));
        print(program, rows);
      });
    });

  // timeline add
  addDryRun(
    timelineCmd
      .command("add")
      .argument("<slug>", "page slug")
      .requiredOption("--date <date>", "date (YYYY-MM-DD or ISO)")
      .requiredOption("--summary <summary>", "one-line summary")
      .option("--source <source>", "event source", "manual")
      .option("--detail <detail>", "detail markdown", "")
      .description("add a timeline entry")
      .addHelpText("after", `
Examples:
  ebrain timeline add projects/alpha --date 2025-03-15 --summary "v1.0 shipped"
  ebrain timeline add projects/alpha --date 2025-03-15 --summary "launch" --source release
  ebrain timeline add projects/alpha --date 2025-03-15 --summary "launch" --dry-run
`),
  ).action(async (slug: string, opts: {
    date: string;
    summary: string;
    source?: string;
    detail?: string;
    dryRun?: boolean;
  }) => {
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
  });

  // timeline extract
  addDryRun(
    timelineCmd
      .command("extract")
      .argument("<slug>", "page slug")
      .option("--source <source>", "source identifier", "extracted")
      .option("--default-date <date>", "default date (YYYY-MM-DD)")
      .description("extract timeline events from page content using AI")
      .addHelpText("after", `
Examples:
  ebrain timeline extract companies/river-ai
  ebrain timeline extract docs/meeting --source meeting_notes --default-date 2024-03-15
`),
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

  // timeline global
  timelineCmd
    .command("global")
    .option("--limit <number>", "max results", "100")
    .description("list timeline entries across all pages")
    .addHelpText("after", `
Examples:
  ebrain timeline global
  ebrain timeline global --limit 20
`)
    .action(async (opts: Record<string, string>) => {
      await withRepo(program, async (repo) => {
        const entries = await repo.timelineGlobal(Number(opts.limit ?? 100));
        print(program, entries);
      });
    });
}
