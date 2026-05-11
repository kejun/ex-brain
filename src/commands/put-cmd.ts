import { basename, extname, resolve } from "node:path";
import { Command } from "commander";
import { inferTypeFromSlug, slugToTitle, normalizeLongSlug, slugify } from "../slug-utils";
import { loadDocument, detectKind, type DocumentKind } from "../markdown/document-loader";
import { parsePageMarkdown, renderPageMarkdown } from "../markdown/parser";
import { BrainRepository } from "../repositories/brain-repo";
import {
  addDryRun,
  isDryRun,
  contentHash,
  withRepo,
  isJson,
  print,
  normalizeLinkSlug,
} from "./shared";
import { applyEntityLinks } from "./entity-links";
import {
  success,
  warning,
  subItem,
  keyValue,
  header,
  createSpinner,
} from "../utils/cli-output";
import { formatDuration } from "../utils/progress";
import {
  readMaybeStdin,
  readTextFile,
} from "../markdown/io";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Non-markdown extensions that should use the document ingestion path. */
const DOC_EXTENSIONS = new Set([
  "pdf", "docx", "doc", "html", "htm", "json", "txt", "text",
]);

/** Whether a file path should be treated as a document (not markdown). */
function isDocumentFile(filePath: string, forceKind?: string): boolean {
  if (forceKind && forceKind !== "markdown") return true;
  const ext = extname(filePath).toLowerCase().replace(/^\./, "");
  return DOC_EXTENSIONS.has(ext);
}

async function resolveInput(
  fileOpt: string | undefined,
  stdin: boolean,
): Promise<string> {
  if (fileOpt) return readTextFile(resolve(fileOpt));
  return readMaybeStdin().then((s) => s ?? "");
}

// ---------------------------------------------------------------------------
// Put command
// ---------------------------------------------------------------------------

export function registerPutCommand(program: Command): void {
  addDryRun(
    program
      .command("put")
      .argument("[slug]", "page slug (optional; auto-generated if omitted)")
      .option("--file <path>", "read content from file (markdown, pdf, docx, html, txt, json)")
      .option("--stdin", "read markdown from stdin", false)
      .option("--type <type>", "page type override")
      .option("--title <title>", "page title override")
      .option("--format <kind>", "force document kind (pdf|docx|html|json|markdown|text) — only needed for --file with non-md files when auto-detect fails")
      .option("--max-bytes <number>", "max bytes for URL/file ingest", "52428800")
      .option("--timeout <ms>", "fetch timeout for URLs in ms", "30000")
      .description(
        "create or update a page (idempotent; upserts by slug). Auto-detects file type: markdown is parsed normally, PDF/DOCX/HTML/TXT/JSON are extracted and ingested.",
      )
      .addHelpText(
        "after",
        `
Examples:
  ebrain put --file api.md                  # markdown → parsePageMarkdown
  ebrain put docs/api --file api.md         # explicit slug
  ebrain put --file report.pdf              # pdf → auto-extract text
  ebrain put docs/report --file report.pdf  # explicit slug for pdf
  ebrain put --file article.docx            # docx → auto-extract text
  ebrain put --file https://example.com/a.pdf  # URL → download + extract
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
        format?: string;
        maxBytes?: string;
        timeout?: string;
        dryRun?: boolean;
      },
    ) => {
      // ── Branch 1: document file (pdf/docx/html/txt/json or URL) ──
      const forceKind = opts.format as DocumentKind | undefined;
      if (opts.file && isDocumentFile(opts.file, opts.format)) {
        const loaded = await loadDocument(opts.file, {
          forceKind,
          fetchTimeoutMs: opts.timeout ? Number(opts.timeout) : undefined,
          maxBytes: opts.maxBytes ? Number(opts.maxBytes) : undefined,
        });
        const content = loaded.text;
        const fileName = loaded.fileName;
        const kind = loaded.kind;
        const sourceRef = loaded.source;
        const sourceType = loaded.sourceType;
        const mimeType = loaded.mimeType;
        const bytes = loaded.bytes;
        const metadata = loaded.metadata;

        let finalSlug = slug;
        if (!finalSlug) {
          const nameNoExt = fileName.replace(/\.[^.]+$/, "");
          const slugBase = normalizeLongSlug(slugify(nameNoExt));
          finalSlug = `ingest/${slugBase}`;
        }

        const type = opts.type ?? kind;
        const title =
          opts.title ??
          String(slugToTitle(finalSlug));
        const hash = contentHash(content);
        const frontmatter: Record<string, unknown> = {
          sourceFile: sourceRef,
          sourceType,
          sourceKind: kind,
          sourceMimeType: mimeType,
          sourceBytes: bytes,
          sourceFileName: fileName,
          _contentHash: hash,
          ...metadata,
        };

        if (isDryRun(opts)) {
          print(program, {
            dryRun: true,
            action: "put",
            slug: finalSlug,
            type,
            title,
            kind,
            sourceType,
            sourceRef,
            mimeType,
            bytes,
            contentLength: content.length,
            contentHash: hash,
            metadata,
          });
          return;
        }

        await withRepo(program, async (repo) => {
          const jsonOut = isJson(program);
          const spinner = createSpinner();
          const startTime = Date.now();

          // Check if content has already been ingested (idempotency)
          const existingPage = await repo.getPage(finalSlug);
          const existingHash = existingPage?.frontmatter._contentHash as string | undefined;

          if (existingHash === hash) {
            if (!jsonOut) {
              header(`Put: ${fileName}`);
              success(`Content unchanged — skipped (hash: ${hash})`);
            }
            print(program, {
              ok: true,
              action: "put",
              slug: finalSlug,
              unchanged: true,
              contentHash: hash,
            });
            return;
          }

          if (!jsonOut) {
            header(`Put: ${fileName}`);
            keyValue("Kind", kind);
            keyValue("Source", sourceRef);
            if (mimeType) keyValue("Content-Type", mimeType);
            keyValue("Bytes", String(bytes));
            if (existingPage) {
              keyValue("Previous hash", existingHash ?? "none");
              keyValue("New hash", hash);
            }
            spinner.start(`Creating page from ${kind}...`);
          }

          await repo.putPage({
            slug: finalSlug,
            type,
            title,
            compiledTruth: content,
            timeline: "",
            frontmatter,
          });

          if (!jsonOut) {
            spinner.succeed(`Page created: ${finalSlug}`);
            keyValue("Type", type);
            keyValue("Content length", `${content.length} chars`);
          }

          // ── Side-effect operations (only on new/changed content) ──
          await repo.timelineAdd({
            pageSlug: finalSlug,
            date: new Date().toISOString().slice(0, 10),
            source: type,
            summary: `Ingested ${kind} ${fileName}`,
            detail: sourceType === "url" ? `Source URL: ${sourceRef}` : "",
          });

          try {
            await repo.writeRaw(finalSlug, sourceType, {
              fileName,
              sourceRef,
              kind,
              mimeType,
              bytes,
              metadata,
              ingestedAt: new Date().toISOString(),
            });
          } catch (err) {
            if (!jsonOut) {
              warning(
                `failed to record raw_data: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }

          await applyEntityLinks(repo, finalSlug, content, jsonOut);

          if (!jsonOut) {
            const duration = formatDuration(Date.now() - startTime);
            success(`Operation completed in ${duration}`);
          }

          print(program, {
            ok: true,
            action: "put",
            slug: finalSlug,
            kind,
            sourceType,
            sourceRef,
            bytes,
            contentLength: content.length,
            contentHash: hash,
          });
        });
        return;
      }

      // ── Branch 2: markdown (stdin or .md file) ──
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

      // Compute content hash and embed in frontmatter for idempotency
      const hash = contentHash(parsed.compiledTruth);
      parsed.frontmatter._contentHash = hash;

      if (isDryRun(opts)) {
        print(program, {
          dryRun: true,
          action: "put",
          slug: finalSlug,
          type,
          title,
          contentLength: parsed.compiledTruth.length,
          contentHash: hash,
          hasTimeline: !!parsed.timeline,
          frontmatterKeys: Object.keys(parsed.frontmatter),
        });
        return;
      }

      await withRepo(program, async (repo) => {
        const jsonOut = isJson(program);
        const spinner = createSpinner();
        const startTime = Date.now();

        // Check if content is unchanged (idempotency)
        const existingPage = await repo.getPage(finalSlug);
        const existingHash = existingPage?.frontmatter._contentHash as string | undefined;

        if (existingHash === hash) {
          // Even when content is unchanged, sync frontmatter tags to page_tags
          // so `ebrain list --tag` works correctly.
          await repo.syncTagsFromFrontmatter(finalSlug, parsed.frontmatter);
          if (!jsonOut) {
            header(`Put: ${finalSlug}`);
            success(`Content unchanged — skipped (hash: ${hash})`);
          }
          print(program, {
            ok: true,
            action: "put",
            slug: finalSlug,
            unchanged: true,
            contentHash: hash,
          });
          return;
        }

        if (!jsonOut) {
          header(`Put: ${finalSlug}`);
          if (existingPage) {
            keyValue("Previous hash", existingHash ?? "none");
            keyValue("New hash", hash);
          }
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

        // Sync frontmatter tags to page_tags table so --tag filter works
        const synced = await repo.syncTagsFromFrontmatter(finalSlug, parsed.frontmatter);
        if (!jsonOut && synced > 0) {
          subItem(`${synced} tag(s) synced`);
        }

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

        print(program, {
          ok: true,
          slug: page.slug,
          updatedAt: page.updatedAt,
          contentHash: hash,
        });
      });
    },
  );

  // -- get ------------------------------------------------------------------
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

  // -- delete ---------------------------------------------------------------
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

  // -- list -----------------------------------------------------------------
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
}
