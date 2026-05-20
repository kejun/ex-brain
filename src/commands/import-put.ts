/**
 * Shared single-file put logic used by both `ebrain put --file` and
 * `ebrain import`.  Import calls this function serially with a 600 ms
 * delay between files; `put` calls it once per invocation.
 */
import { basename, dirname, extname, resolve } from "node:path";
import { loadDocument, detectKind, type DocumentKind } from "../markdown/document-loader";
import { pathToSlug, readTextFile } from "../markdown/io";
import { parsePageMarkdown } from "../markdown/parser";
import { BrainRepository } from "../repositories/brain-repo";
import { contentHash } from "./shared";
import { applyEntityLinks } from "./entity-links";
import { inferTypeFromSlug, normalizeLongSlug, slugify, slugToTitle } from "../slug-utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface PutFileResult {
  /** Final slug of the page */
  slug: string;
  /** Content length in characters */
  contentLength: number;
  /** Content hash (first 16 chars of SHA-256) */
  contentHash: string;
  /** Whether the page was unchanged and skipped */
  unchanged: boolean;
}

export interface PutFileOptions {
  repo: BrainRepository;
  /** Absolute path to the file */
  filePath: string;
  /** Explicit slug override */
  slug?: string;
  /** Type override (e.g. "person", "note") */
  type?: string;
  /** Title override */
  title?: string;
  /** Force document kind (only for non-md files) */
  format?: DocumentKind;
  /** Maximum bytes for file ingest (default 50 MB) */
  maxBytes?: number;
  /** Fetch timeout for URLs in ms (default 30 000) */
  timeout?: number;
  /** Whether to run entity extraction (default true) */
  entityLinks?: boolean;
  /** Whether to embed in search index (default true) */
  embed?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const DOC_EXTENSIONS = new Set([
  "pdf", "docx", "doc", "html", "htm", "json", "txt", "text",
]);

function isDocumentFile(filePath: string, forceKind?: string): boolean {
  if (forceKind && forceKind !== "markdown") return true;
  const ext = extname(filePath).toLowerCase().replace(/^\./, "");
  return DOC_EXTENSIONS.has(ext);
}

/* ------------------------------------------------------------------ */
/*  Core: put a single file                                            */
/* ------------------------------------------------------------------ */

export async function putFile(opts: PutFileOptions): Promise<PutFileResult> {
  const {
    repo,
    filePath,
    type: typeOverride,
    title: titleOverride,
    format,
    maxBytes,
    timeout,
    entityLinks = true,
    embed = true,
  } = opts;

  const isDoc = isDocumentFile(filePath, format);

  // ── Branch 1: document file (pdf/docx/html/txt/json) ──
  if (isDoc) {
    const loaded = await loadDocument(filePath, {
      forceKind: format,
      fetchTimeoutMs: timeout,
      maxBytes,
    });

    const { text: content, kind, fileName, source: sourceRef, sourceType, mimeType, bytes, metadata } = loaded;
    let finalSlug = opts.slug;
    if (!finalSlug) {
      const nameNoExt = fileName.replace(/\.[^.]+$/, "");
      finalSlug = `ingest/${normalizeLongSlug(slugify(nameNoExt))}`;
    }

    const type = typeOverride ?? kind;
    const title = titleOverride ?? String(slugToTitle(finalSlug));
    const hash = contentHash(content);

    // Idempotency check
    const existingPage = await repo.getPage(finalSlug);
    const existingHash = (existingPage?.frontmatter?._contentHash) as string | undefined;
    if (existingHash === hash) {
      await repo.syncTagsFromFrontmatter(finalSlug, {
        _contentHash: hash,
        sourceFile: sourceRef,
        sourceType,
        sourceKind: kind,
        sourceMimeType: mimeType,
        sourceBytes: bytes,
        sourceFileName: fileName,
        ...metadata,
      });
      return { slug: finalSlug, contentLength: content.length, contentHash: hash, unchanged: true };
    }

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

    await repo.putPage({ slug: finalSlug, type, title, compiledTruth: content, timeline: "", frontmatter }, embed);

    if (entityLinks) {
      await applyEntityLinks(repo, finalSlug, content, true);
    }

    return { slug: finalSlug, contentLength: content.length, contentHash: hash, unchanged: false };
  }

  // ── Branch 2: markdown ──
  const content = await readTextFile(filePath);
  const parsed = parsePageMarkdown(content);

  let finalSlug = opts.slug;
  if (!finalSlug) {
    finalSlug = normalizeLongSlug(slugify(basename(filePath).replace(/\.md$/i, "")));
  }

  const type = typeOverride ?? String(parsed.frontmatter.type ?? inferTypeFromSlug(finalSlug));
  const title = titleOverride ?? String(parsed.frontmatter.title ?? slugToTitle(finalSlug));
  const hash = contentHash(parsed.compiledTruth);

  // Idempotency check
  const existingPage = await repo.getPage(finalSlug);
  const existingHash = (existingPage?.frontmatter?._contentHash) as string | undefined;
  if (existingHash === hash) {
    await repo.syncTagsFromFrontmatter(finalSlug, parsed.frontmatter);
    return { slug: finalSlug, contentLength: parsed.compiledTruth.length, contentHash: hash, unchanged: true };
  }

  parsed.frontmatter._contentHash = hash;

  await repo.putPage({
    slug: finalSlug,
    type,
    title,
    compiledTruth: parsed.compiledTruth,
    timeline: parsed.timeline,
    frontmatter: parsed.frontmatter,
  }, embed);

  await repo.syncTagsFromFrontmatter(finalSlug, parsed.frontmatter);

  if (entityLinks) {
    await applyEntityLinks(repo, finalSlug, parsed.compiledTruth, true);
  }

  return { slug: finalSlug, contentLength: parsed.compiledTruth.length, contentHash: hash, unchanged: false };
}
