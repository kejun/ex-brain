import { dirname, extname, resolve } from "node:path";
import { Command } from "commander";
import { stat } from "node:fs/promises";
import { inferTypeFromSlug, slugToTitle, normalizeLongSlug, slugify } from "../slug-utils";
import { loadDocument, collectDocumentFiles, detectKind, type DocumentKind } from "../markdown/document-loader";
import { collectMarkdownFiles, pathToSlug, readTextFile } from "../markdown/io";
import { parsePageMarkdown, extractWikiStyleLinks, extractTimelineLines } from "../markdown/parser";
import { extractRelations, entityToSlug, type EntityType, type RelationType, type EntityRef } from "../ai/entity-link";
import { loadSettings } from "../settings";
import { BrainRepository } from "../repositories/brain-repo";
import { addDryRun, isDryRun, contentHash, withRepo, isJson, print, normalizeLinkSlug } from "./shared";
import { success, warning, subItem, keyValue, header, createSpinner } from "../utils/cli-output";
import { formatDuration } from "../utils/progress";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      for (const f of mdFiles) results.push({ file: f, root: rp });
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
      for (const f of docFiles) results.push({ file: f, root: rp });
    } else if (s.isFile() && isDocumentFile(rp)) {
      results.push({ file: rp, root: dirname(rp) });
    }
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

interface EntityRelation {
  type: "relation";
  from: EntityRef;
  to: EntityRef;
  relation: RelationType;
  context: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Import command
// ---------------------------------------------------------------------------

export function registerImportCommand(program: Command): void {
  addDryRun(
    program
      .command("import")
      .argument("<paths...>", "directories or files (markdown, PDF, DOCX) to import")
      .description("import markdown, PDF, and DOCX files — accepts directories (recursive) and/or individual files")
      .option("--skip-index", "skip vector indexing (useful if seekdb crashes)")
      .addHelpText(
        "after",
        `
Examples:
  ebrain import ./docs                        # import a directory
  ebrain import *.docx                        # import matching files (shell glob)
  ebrain import report.pdf notes.md ./docs    # mix of files and directories
  ebrain import ./docs --dry-run
  ebrain import ./docs --skip-index           # skip vector indexing
`,
      ),
  ).action(async (paths: string[], opts: { dryRun?: boolean; skipIndex?: boolean }) => {
    await withRepo(program, async (repo) => {
      const mdEntries = await collectMarkdownFilesFromPaths(paths);
      const files = mdEntries.map((e) => e.file);

      if (isDryRun(opts)) {
        print(program, {
          dryRun: true,
          action: "import",
          paths: paths.map((p) => resolve(p)),
          filesFound: files.length,
          slugs: mdEntries.map((e) => pathToSlug(e.file, e.root)),
        });
        return;
      }

      const jsonOut = isJson(program);
      const settings = await loadSettings();
      const spinner = createSpinner();
      const startTime = Date.now();

      if (!jsonOut) {
        header(`Import: ${paths.map((p) => resolve(p)).join(", ")}`);
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

      for (let i = 0; i < mdEntries.length; i++) {
        const { file, root } = mdEntries[i]!;
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

      // Phase 1.5: Scan for docx/pdf files
      const writeErrors: string[] = [];

      if (!jsonOut) {
        spinner.start("Scanning for PDF/DOCX files...");
      }
      const docEntries = await collectDocumentFilesFromPaths(paths);
      const docFilePaths = docEntries.map((e) => e.file);

      const docFileData: Array<{
        file: string;
        slug: string;
        content: string;
        kind: DocumentKind;
        fileName: string;
        sourceRef: string;
        sourceType: "file" | "url";
        mimeType: string | undefined;
        bytes: number;
        metadata: Record<string, unknown>;
      }> = [];

      for (let i = 0; i < docFilePaths.length; i++) {
        const file = docFilePaths[i]!;
        const root = docEntries[i]!.root;
        if (!jsonOut) {
          spinner.update(`Extracting documents... ${i + 1}/${docFilePaths.length}`);
        }
        try {
          const loaded = await loadDocument(file, { forceKind: detectKind({ fileName: file }) });
          const rawSlug = pathToSlug(file, root);
          const slug = normalizeLongSlug(rawSlug);
          docFileData.push({
            file,
            slug,
            content: loaded.text,
            kind: loaded.kind,
            fileName: loaded.fileName,
            sourceRef: loaded.source,
            sourceType: loaded.sourceType,
            mimeType: loaded.mimeType,
            bytes: loaded.bytes,
            metadata: loaded.metadata,
          });
        } catch (err) {
          writeErrors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (!jsonOut) {
        spinner.succeed(`Found ${docFilePaths.length} PDF/DOCX files`);
        if (writeErrors.length > 0) {
          warning(`${writeErrors.length} files failed to extract`);
        }
      }

      // Phase 2: Write all pages first (skip embed for performance)
      if (!jsonOut) {
        spinner.start(`Writing ${fileData.length + docFileData.length} pages to database...`);
      }

      const allSlugs: string[] = [];

      for (let i = 0; i < fileData.length; i++) {
        const { slug, parsed } = fileData[i]!;
        if (!jsonOut && i % 20 === 0) {
          spinner.update(`Writing pages... ${i + 1}/${fileData.length + docFileData.length}`);
        }
        try {
          await repo.putPage({
            slug,
            type: String(parsed.frontmatter.type ?? inferTypeFromSlug(slug)),
            title: String(parsed.frontmatter.title ?? slugToTitle(slug)),
            compiledTruth: parsed.compiledTruth,
            timeline: parsed.timeline,
            frontmatter: parsed.frontmatter,
          }, true);
          allSlugs.push(slug);
        } catch (err) {
          writeErrors.push(`${slug}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      for (let i = 0; i < docFileData.length; i++) {
        const { slug, content, kind, sourceRef, sourceType, mimeType, bytes, metadata, fileName } = docFileData[i]!;
        if (!jsonOut) {
          spinner.update(`Writing pages... ${fileData.length + i + 1}/${fileData.length + docFileData.length}`);
        }
        try {
          const hash = contentHash(content);
          const type = kind;
          const title = String(slugToTitle(slug));
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
          await repo.putPage({
            slug,
            type,
            title,
            compiledTruth: content,
            timeline: "",
            frontmatter,
          }, true);
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

      // Phase 3: Parallel entity extraction
      const BATCH_SIZE = 10;
      const entityResults = new Map<string, EntityRelation[]>();

      if (settings.llm.baseURL) {
        if (!jsonOut) {
          spinner.start(`Extracting entities with LLM...`);
        }

        const allPages: Array<{ slug: string; content: string }> = [
          ...fileData.map(({ slug, content }) => ({ slug, content })),
          ...docFileData.map(({ slug, content }) => ({ slug, content })),
        ];

        for (let i = 0; i < allPages.length; i += BATCH_SIZE) {
          const batch = allPages.slice(i, i + BATCH_SIZE);
          if (!jsonOut) {
            spinner.update(`Extracting entities... ${Math.min(i + BATCH_SIZE, allPages.length)}/${allPages.length}`);
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

      const allTimelineEntries: Array<{
        pageSlug: string;
        date: string;
        source: string;
        summary: string;
        detail: string;
      }> = [];

      for (const { slug, wikiLinks, timelineEntries, tags } of fileData) {
        for (const link of wikiLinks) {
          await repo.link(slug, link, "import");
          linkCount++;
        }

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

        for (const tag of tags) {
          await repo.tag(slug, tag);
          tagCount++;
        }

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

      for (const { slug } of docFileData) {
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

      for (const { slug, kind, fileName } of docFileData) {
        allTimelineEntries.push({
          pageSlug: slug,
          date: new Date().toISOString().slice(0, 10),
          source: "import",
          summary: `Ingested ${kind}: ${fileName}`,
          detail: "",
        });
        timelineCount++;
      }

      if (allTimelineEntries.length > 0) {
        await repo.timelineAddBatch(allTimelineEntries);
      }

      if (!jsonOut) {
        spinner.succeed(`Created links, tags, and timeline`);
      }

      // Phase 5: Batch sync all pages to search index
      if (opts.skipIndex) {
        if (!jsonOut) {
          success(`Skipping vector indexing (--skip-index)`);
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
        header("Import Summary");
        keyValue("Markdown files", String(files.length));
        keyValue("PDF/DOCX files", String(docFilePaths.length));
        keyValue("Pages created", String(allSlugs.length));
        keyValue("Entities extracted", String(entityCount));
        keyValue("Links created", String(linkCount));
        keyValue("Timeline entries", String(timelineCount));
        keyValue("Tags added", String(tagCount));
        keyValue("Duration", duration);

        if (writeErrors.length > 0) {
          warning(`${writeErrors.length} files had errors`);
        }
      }

      print(program, {
        ok: true,
        markdownFiles: files.length,
        docFiles: docFilePaths.length,
        pages: allSlugs.length,
        links: linkCount,
        timelineEntries: timelineCount,
        entities: entityCount,
      });
    });
  });
}
