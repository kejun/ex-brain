import { Command } from "commander";
import { addDryRun, isDryRun, withRepo, isJson, print } from "./shared";
import { readMaybeStdin } from "../markdown/io";

export function registerTagCommand(program: Command): void {
  const tagCmd = program
    .command("tag")
    .description("manage tags on a page");

  tagCmd
    .command("list")
    .argument("<slug>", "page slug")
    .description("list tags on a page")
    .addHelpText("after", `
Examples:
  ebrain tag list docs/api
`)
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
      .addHelpText("after", `
Examples:
  ebrain tag add docs/api rest
  ebrain tag add docs/api rest --dry-run
`),
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
      .addHelpText("after", `
Examples:
  ebrain tag remove docs/api outdated
  ebrain tag remove docs/api outdated --dry-run
`),
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
}

export function registerRawCommand(program: Command): void {
  const rawCmd = program
    .command("raw")
    .description("manage raw source data for a page");

  rawCmd
    .command("get")
    .argument("<slug>", "page slug")
    .option("--source <source>", "filter by source name")
    .description("read raw source data for a page")
    .addHelpText("after", `
Examples:
  ebrain raw get ingest/report
  ebrain raw get ingest/report --source crm
`)
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
      .addHelpText("after", `
Examples:
  ebrain raw set ingest/report --source crm --data '{"rev": 1000}'
  echo '{"rev": 1000}' | ebrain raw set ingest/report --source crm --stdin
  ebrain raw set ingest/report --source crm --data '{"rev": 1000}' --dry-run
`),
  ).action(async (slug: string, opts: {
    source: string;
    data?: string;
    stdin?: boolean;
    dryRun?: boolean;
  }) => {
    let data: unknown;
    if (opts.data) {
      data = JSON.parse(opts.data);
    } else if (opts.stdin) {
      const raw = await readMaybeStdin();
      if (!raw?.trim()) throw new Error("empty stdin - pipe JSON");
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
  });
}

export function registerLinkCommand(program: Command): void {
  addDryRun(
    program
      .command("link")
      .argument("<from>", "source page slug")
      .argument("<to>", "target page slug")
      .option("--context <text>", "link context", "")
      .description("create a cross-link between pages (idempotent)")
      .addHelpText("after", `
Examples:
  ebrain link docs/api docs/getting-started
  ebrain link people/john projects/alpha --context "lead"
  ebrain link docs/api docs/getting-started --dry-run
`),
  ).action(async (from: string, to: string, opts: { context?: string; dryRun?: boolean }) => {
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
  });

  program
    .command("backlinks")
    .argument("<slug>", "target page slug")
    .description("list pages that link to this page")
    .addHelpText("after", `
Examples:
  ebrain backlinks docs/api
`)
    .action(async (slug: string) => {
      await withRepo(program, async (repo) => {
        const links = await repo.backlinks(slug);
        print(program, links);
      });
    });
}
