import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

/** Supported document kinds for ingestion. */
export type DocumentKind =
  | "text"
  | "markdown"
  | "pdf"
  | "docx"
  | "doc"
  | "html"
  | "json"
  | "unknown";

export interface LoadedDocument {
  /** Extracted plain-text content (utf-8). */
  text: string;
  /** Original file/URL name without parent path. */
  fileName: string;
  /** Detected document kind. */
  kind: DocumentKind;
  /** Source descriptor: an absolute path for files or the original URL. */
  source: string;
  /** Where the source came from. */
  sourceType: "url" | "file";
  /** MIME type detected from response headers or file extension. */
  mimeType?: string;
  /** Byte size of the *raw* source (downloaded bytes or file size). */
  bytes: number;
  /** Extra metadata: page count for PDF, mammoth warnings, etc. */
  metadata: Record<string, unknown>;
}

export interface LoadDocumentOptions {
  /** Override automatic kind detection. */
  forceKind?: DocumentKind;
  /** Network fetch timeout (ms). Default: 30s. */
  fetchTimeoutMs?: number;
  /** Maximum bytes accepted from a remote URL. Default: 50 MB. */
  maxBytes?: number;
  /** Custom user-agent for URL fetches. */
  userAgent?: string;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_UA = "ebrain-ingest/1 (+https://github.com/ebrain)";

/**
 * Detect whether `input` is a remote URL (http/https) we should download.
 * `file://` URLs are treated as local files.
 */
export function isRemoteUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

/**
 * Map a file extension or content-type to a DocumentKind.
 * Returns `"unknown"` if no clear match is found.
 */
export function detectKind(opts: {
  fileName?: string;
  contentType?: string;
}): DocumentKind {
  const ct = (opts.contentType ?? "").toLowerCase().split(";")[0]?.trim();
  if (ct) {
    if (ct === "application/pdf") return "pdf";
    if (
      ct ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      ct === "application/vnd.ms-word.document.macroenabled.12"
    )
      return "docx";
    if (ct === "application/msword") return "doc";
    if (ct === "text/markdown" || ct === "text/x-markdown") return "markdown";
    if (ct === "text/html" || ct === "application/xhtml+xml") return "html";
    if (ct === "application/json" || ct.endsWith("+json")) return "json";
    if (ct.startsWith("text/")) return "text";
  }
  const ext = (extname(opts.fileName ?? "").toLowerCase() || "").replace(
    /^\./,
    "",
  );
  switch (ext) {
    case "pdf":
      return "pdf";
    case "docx":
      return "docx";
    case "doc":
      return "doc";
    case "md":
    case "markdown":
    case "mdx":
      return "markdown";
    case "htm":
    case "html":
    case "xhtml":
      return "html";
    case "json":
      return "json";
    case "txt":
    case "text":
    case "log":
    case "csv":
    case "tsv":
    case "yaml":
    case "yml":
    case "ini":
    case "rst":
    case "org":
      return "text";
    default:
      return "unknown";
  }
}

interface FetchedResource {
  bytes: Buffer;
  fileName: string;
  contentType?: string;
}

async function fetchUrl(
  url: string,
  opts: Required<Pick<LoadDocumentOptions, "fetchTimeoutMs" | "maxBytes" | "userAgent">>,
): Promise<FetchedResource> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.fetchTimeoutMs);
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { "User-Agent": opts.userAgent, Accept: "*/*" },
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to fetch ${url}: ${reason}`);
  }
  clearTimeout(timer);
  if (!resp.ok) {
    throw new Error(`fetch ${url} returned HTTP ${resp.status} ${resp.statusText}`);
  }
  const contentLength = Number(resp.headers.get("content-length") ?? "0");
  if (contentLength && contentLength > opts.maxBytes) {
    throw new Error(
      `remote document too large: ${contentLength} bytes (limit ${opts.maxBytes})`,
    );
  }
  const ab = await resp.arrayBuffer();
  if (ab.byteLength > opts.maxBytes) {
    throw new Error(
      `remote document too large: ${ab.byteLength} bytes (limit ${opts.maxBytes})`,
    );
  }
  const contentType = resp.headers.get("content-type") ?? undefined;
  const fileName = inferFileNameFromUrl(url, resp, contentType);
  return { bytes: Buffer.from(ab), fileName, contentType };
}

function inferFileNameFromUrl(
  url: string,
  resp: Response,
  contentType?: string,
): string {
  // 1. Content-Disposition wins if it carries a filename.
  const dispo = resp.headers.get("content-disposition");
  if (dispo) {
    const m =
      /filename\*=UTF-8''([^;]+)/i.exec(dispo) ??
      /filename="?([^";]+)"?/i.exec(dispo);
    if (m && m[1]) {
      try {
        return decodeURIComponent(m[1]).trim();
      } catch {
        return m[1].trim();
      }
    }
  }
  // 2. Last path segment of the *final* URL (after redirects).
  const finalUrl = resp.url || url;
  let pathname = "";
  try {
    pathname = new URL(finalUrl).pathname;
  } catch {
    pathname = finalUrl;
  }
  const last = pathname.split("/").filter(Boolean).pop() ?? "";
  if (last && /\.[a-z0-9]{1,8}$/i.test(last)) {
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  }
  // 3. Synthesise from host + content-type extension.
  let host = "remote";
  try {
    host = new URL(finalUrl).hostname.replace(/^www\./, "");
  } catch {
    // ignore
  }
  const ext = mimeToExt(contentType);
  return ext ? `${host}.${ext}` : host;
}

function mimeToExt(contentType?: string): string | undefined {
  const ct = (contentType ?? "").toLowerCase().split(";")[0]?.trim();
  if (!ct) return undefined;
  if (ct === "application/pdf") return "pdf";
  if (
    ct ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  )
    return "docx";
  if (ct === "application/msword") return "doc";
  if (ct === "text/markdown" || ct === "text/x-markdown") return "md";
  if (ct === "text/html" || ct === "application/xhtml+xml") return "html";
  if (ct === "application/json" || ct.endsWith("+json")) return "json";
  if (ct.startsWith("text/")) return "txt";
  return undefined;
}

/**
 * Detect kind from raw bytes magic numbers. Used as a tie-breaker when the
 * extension/content-type is missing or wrong.
 */
function detectKindFromMagic(bytes: Buffer): DocumentKind | undefined {
  if (bytes.length >= 4) {
    // %PDF-
    if (
      bytes[0] === 0x25 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x44 &&
      bytes[3] === 0x46
    )
      return "pdf";
    // PK\x03\x04 → ZIP container (docx, xlsx, …); we assume docx here, callers can override.
    if (
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      bytes[2] === 0x03 &&
      bytes[3] === 0x04
    )
      return "docx";
    // \xD0\xCF\x11\xE0 → legacy OLE (.doc, .xls)
    if (
      bytes[0] === 0xd0 &&
      bytes[1] === 0xcf &&
      bytes[2] === 0x11 &&
      bytes[3] === 0xe0
    )
      return "doc";
  }
  return undefined;
}

/** Strip HTML tags + collapse whitespace into plain text. */
export function htmlToPlainText(html: string): string {
  // Remove <script>/<style> blocks entirely.
  let s = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // Convert block-level tags to newlines so paragraphs survive.
  s = s.replace(/<\/(p|div|section|article|li|h[1-6]|tr|table|br)\s*>/gi, "\n");
  s = s.replace(/<br\s*\/?>(?=)/gi, "\n");
  // Drop remaining tags.
  s = s.replace(/<[^>]+>/g, "");
  // Decode the most common HTML entities.
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) =>
      String.fromCodePoint(Number(d)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) =>
      String.fromCodePoint(Number.parseInt(h, 16)),
    );
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function extractPdf(
  bytes: Buffer,
): Promise<{ text: string; metadata: Record<string, unknown> }> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const data = new Uint8Array(bytes);
  const pdf = await getDocumentProxy(data);
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return {
    text: text.trim(),
    metadata: { pageCount: totalPages, parser: "unpdf" },
  };
}

async function extractDocx(
  bytes: Buffer,
): Promise<{ text: string; metadata: Record<string, unknown> }> {
  const mammothMod = await import("mammoth");
  // CJS-from-ESM: mammoth exports the API on default in some toolchains.
  const mammoth: typeof import("mammoth") =
    (mammothMod as unknown as { default?: typeof import("mammoth") }).default ??
    (mammothMod as unknown as typeof import("mammoth"));
  const result = await mammoth.extractRawText({ buffer: bytes });
  const warnings = result.messages
    .filter((m) => m.type === "warning")
    .map((m) => m.message);
  const errors = result.messages
    .filter((m) => m.type === "error")
    .map((m) => m.message);
  return {
    text: result.value.trim(),
    metadata: {
      parser: "mammoth",
      warnings,
      ...(errors.length > 0 ? { errors } : {}),
    },
  };
}

/**
 * Load and extract text content from a local file path or remote URL.
 *
 * Supported kinds:
 *  - PDF (`.pdf`, `application/pdf`) → text via `unpdf`
 *  - Word `.docx` → text via `mammoth`
 *  - HTML / Markdown / JSON / plain text → utf-8 decoded (HTML stripped)
 *
 * Unsupported `.doc` (legacy OLE) raises a clear error.
 */
export async function loadDocument(
  input: string,
  opts: LoadDocumentOptions = {},
): Promise<LoadedDocument> {
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_TIMEOUT;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const userAgent = opts.userAgent ?? DEFAULT_UA;

  let bytes: Buffer;
  let fileName: string;
  let source: string;
  let sourceType: "url" | "file";
  let mimeType: string | undefined;

  if (isRemoteUrl(input)) {
    const fetched = await fetchUrl(input, {
      fetchTimeoutMs,
      maxBytes,
      userAgent,
    });
    bytes = fetched.bytes;
    fileName = fetched.fileName;
    source = input;
    sourceType = "url";
    mimeType = fetched.contentType;
  } else {
    const fullPath = resolve(input);
    const st = await stat(fullPath).catch(() => null);
    if (!st || !st.isFile()) {
      throw new Error(`file not found: ${input}`);
    }
    if (st.size > maxBytes) {
      throw new Error(
        `local document too large: ${st.size} bytes (limit ${maxBytes})`,
      );
    }
    bytes = await readFile(fullPath);
    fileName = basename(fullPath);
    source = fullPath;
    sourceType = "file";
  }

  let kind: DocumentKind =
    opts.forceKind ?? detectKind({ fileName, contentType: mimeType });
  // Magic-based fallback / override: covers servers that send
  // `application/octet-stream` for PDFs and ZIP-based docx files.
  if (kind === "unknown" || kind === "text") {
    const magic = detectKindFromMagic(bytes);
    if (magic === "pdf") kind = "pdf";
    else if (magic === "docx") kind = "docx";
    else if (magic === "doc") kind = "doc";
  }

  let text = "";
  let metadata: Record<string, unknown> = {};

  switch (kind) {
    case "pdf": {
      const out = await extractPdf(bytes);
      text = out.text;
      metadata = out.metadata;
      break;
    }
    case "docx": {
      const out = await extractDocx(bytes);
      text = out.text;
      metadata = out.metadata;
      break;
    }
    case "doc":
      throw new Error(
        `legacy .doc (OLE) format is not supported — convert to .docx or PDF first (e.g. via libreoffice --convert-to docx ${fileName})`,
      );
    case "html": {
      text = htmlToPlainText(bytes.toString("utf8"));
      metadata = { parser: "html-strip" };
      break;
    }
    case "json": {
      const raw = bytes.toString("utf8");
      try {
        text = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        text = raw;
      }
      metadata = { parser: "json" };
      break;
    }
    case "markdown":
    case "text":
      text = bytes.toString("utf8");
      metadata = { parser: "utf8" };
      break;
    case "unknown":
    default:
      // Last-ditch: if the bytes look like text, decode; otherwise reject.
      if (looksLikeText(bytes)) {
        text = bytes.toString("utf8");
        metadata = { parser: "utf8-fallback" };
      } else {
        throw new Error(
          `unsupported document format for ${fileName}` +
            (mimeType ? ` (content-type: ${mimeType})` : "") +
            ` — supported: pdf, docx, html, json, txt, md`,
        );
      }
      break;
  }

  if (!text.trim()) {
    throw new Error(
      `no text extracted from ${fileName} (kind=${kind}); document may be image-only or empty`,
    );
  }

  return {
    text,
    fileName,
    kind,
    source,
    sourceType,
    mimeType,
    bytes: bytes.length,
    metadata,
  };
}

/**
 * Heuristic: a binary buffer is "text" if at least 95% of its first 512 bytes
 * are printable ASCII or common UTF-8 continuation bytes.
 */
function looksLikeText(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 512));
  if (sample.length === 0) return false;
  let textLike = 0;
  for (const b of sample) {
    if (b === 0x09 || b === 0x0a || b === 0x0d) {
      textLike++;
      continue;
    }
    if (b >= 0x20 && b <= 0x7e) {
      textLike++;
      continue;
    }
    if (b >= 0x80) {
      // Multi-byte UTF-8 continuation; treat as text too.
      textLike++;
    }
  }
  return textLike / sample.length >= 0.95;
}
