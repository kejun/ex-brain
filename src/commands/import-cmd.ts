import { dirname, extname, resolve } from "node:path";
import { Command } from "commander";
import { stat } from "node:fs/promises";
import { collectDocumentFiles, detectKind, type DocumentKind } from "../markdown/document-loader";
import { collectMarkdownFiles, pathToSlug } from "../markdown/io";
import { BrainRepository } from "../repositories/brain-repo";
import { addDryRun, isDryRun, withRepo, isJson, print, normalizeLinkSlug } from "./shared";
import { putFile } from "./import-put";
import { success, warning, subItem, header, keyValue, createSpinner } from "../utils/cli-output";
import { formatDuration } from "../utils/progress";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DELAY_MS = 600;

const DOC_EXTENSIONS = new Set([
  "pdf", "docx", "doc", "html", "htm", "json", "txt", "text",
]);

function isDocumentFile(filePath: string, forceKind?: string): boolean {
  if (forceKind && forceKind !== "markdown") return true;
  const ext = extname(filePath).toLowerCase().replace(/^\./, "");
  return DOC_EXTENSIONS.has(ext);
}

async function collectMarkdownFilesFromPaths(paths: string[]): Promise<Array<{ file: string; root: string }>> {
  const results: Array<{ file: string; root: string }> = [];
  for (const p of paths) {
    const rp = resolve(p);
    const s = await stat(rp);
    if (s.isDirectory()) {
      const mdFiles = await collectMarkdownFiles(rp);
      for (const f of mdFiles) results.push({ file: f, root: dirname(rp) });
    } else if (s.isFile() && extname(rp).toLowerCase() === ".md") {
      results.push({ file: rp, root: dirname(rp) });
    }
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

async function collectDocumentFilesFromPaths(paths: string[]): Promise<Array<{ file: string; root: string }>> {
  const results: Array<{ file: string; root: string }> = [];
  for (const p of paths) {
    const rp = resolve(p);
    const s = await stat(rp);
    if (s.isDirectory()) {
      const docFiles = await collectDocumentFiles(rp);
      for (const f of docFiles) results.push({ file: f, root: dirname(rp) });
    } else if (s.isFile() && isDocumentFile(rp)) {
      results.push({ file: rp, root: dirname(rp) });
    }
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Import command — collect valid files, then serially put each with 600ms gap
// ---------------------------------------------------------------------------

export function registerImportCommand(program: Command): void {
  addDryRun(
    program
      .command("import")
      .argument("<paths...>", "directories or files (markdown, PDF, DOCX) to import")
      .description("import markdown, PDF, and DOCX files — accepts directories (recursive) and/or individual files")
      .option("--skip-index", "skip vector indexing (useful if seekdb crashes)")
      .option("--skip-entity", "skip entity extraction")
      .addHelpText(
        "after",
        `
Examples:
  ebrain import ./docs                        # import a directory
  ebrain import *.docx                        # import matching files (shell glob)
  ebrain import report.pdf notes.md ./docs    # mix of files and directories
  ebrain import ./docs --dry-run
  ebrain import ./docs --skip-index           # skip vector indexing
  ebrain import ./docs --skip-entity          # skip entity extraction
`,
      ),
  ).action(async (paths: string[], opts: { dryRun?: boolean; skipIndex?: boolean; skipEntity?: boolean }) => {
    await withRepo(program, async (repo) => {
      const jsonOut = isJson(program);
      const startTime = Date.now();
      const spinner = createSpinner();

      // Phase 1: Collect all valid files
      const mdEntries = await collectMarkdownFilesFromPaths(paths);
      const docEntries = await collectDocumentFilesFromPaths(paths);
      const totalFiles = mdEntries.length + docEntries.length;

      if (totalFiles === 0) {
        if (!jsonOut) {
          header("Import");
          warning("No files found");
        }
        print(program, { ok: true, markdownFiles: 0, docFiles: 0, pages: 0, duration: "0ms" });
        return;
      }

      if (isDryRun(opts)) {
        print(program, {
          dryRun: true,
          action: "import",
          paths: paths.map((p) => resolve(p)),
          filesFound: totalFiles,
          slugs: [
            ...mdEntries.map((e) => pathToSlug(e.file, e.root)),
            ...docEntries.map((e) => pathToSlug(e.file, e.root)),
          ],
        });
        return;
      }

      if (!jsonOut) {
        header(`Import: ${paths.map((p) => resolve(p)).join(", ")}`);
        spinner.start(`Found ${totalFiles} files (${mdEntries.length} markdown, ${docEntries.length} documents)`);
        spinner.succeed(`Found ${totalFiles} files`);
      }

      // Phase 2: Serially put each file with 600ms delay
      const allSlugs: string[] = [];
      const writeErrors: string[] = [];
      let createdCount = 0;
      let skippedCount = 0;

      for (let i = 0; i < totalFiles; i++) {
        const isMd = i < mdEntries.length;
        const entry = isMd ? mdEntries[i]! : docEntries[i - mdEntries.length]!;
        const file = entry.file;

        if (!jsonOut) {
          spinner.start(`[${i + 1}/${totalFiles}] ${file}`);
        }

        try {
          const result = await putFile({
            repo,
            filePath: file,
            embed: false, // defer to embedAll at the end
            entityLinks: !opts.skipEntity,
          });

          allSlugs.push(result.slug);
          if (result.unchanged) {
            skippedCount++;
            if (!jsonOut) {
              spinner.warn(`[${i + 1}/${totalFiles}] unchanged — skipped: ${result.slug}`);
            }
          } else {
            createdCount++;
            if (!jsonOut) {
              spinner.succeed(`[${i + 1}/${totalFiles}] ${result.slug} (${result.contentLength} chars)`);
            }
          }
        } catch (err) {
          writeErrors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
          if (!jsonOut) {
            spinner.fail(`[${i + 1}/${totalFiles}] error: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // 600ms delay between files
        if (i < totalFiles - 1) {
          await sleep(DELAY_MS);
        }
      }

      // Phase 3: Search indexing
      if (opts.skipIndex) {
        if (!jsonOut) {
          success(`Skipping vector indexing (--skip-index)`);
        }
      } else if (allSlugs.length > 0) {
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
        header("Import Summary");
        keyValue("Total files", String(totalFiles));
        keyValue("Pages created", String(createdCount));
        keyValue("Pages skipped (unchanged)", String(skippedCount));
        keyValue("Duration", duration);
        if (writeErrors.length > 0) {
          warning(`${writeErrors.length} errors`);
          for (const e of writeErrors.slice(0, 3)) {
            subItem(e);
          }
          if (writeErrors.length > 3) {
            subItem(`... and ${writeErrors.length - 3} more`);
          }
        }
      }

      print(program, {
        ok: true,
        totalFiles,
        created: createdCount,
        skipped: skippedCount,
        errors: writeErrors.length,
        pages: allSlugs.length,
        duration,
      });
    });
  });
}
