import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectKind,
  htmlToPlainText,
  isRemoteUrl,
  loadDocument,
} from "./document-loader";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ebrain-doc-loader-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("isRemoteUrl", () => {
  test.each([
    ["http://example.com/foo.pdf", true],
    ["https://example.com/foo.pdf", true],
    ["HTTPS://EXAMPLE.com/foo", true],
    ["  https://example.com  ", true],
    ["./local/file.pdf", false],
    ["/absolute/file.pdf", false],
    ["file:///local/file.pdf", false],
    ["ftp://example.com/x", false],
  ])("isRemoteUrl(%j) === %s", (input, expected) => {
    expect(isRemoteUrl(input)).toBe(expected);
  });
});

describe("detectKind", () => {
  test("uses content-type when available", () => {
    expect(detectKind({ contentType: "application/pdf" })).toBe("pdf");
    expect(
      detectKind({
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).toBe("docx");
    expect(detectKind({ contentType: "application/msword" })).toBe("doc");
    expect(detectKind({ contentType: "text/html; charset=utf-8" })).toBe("html");
    expect(detectKind({ contentType: "application/json" })).toBe("json");
    expect(
      detectKind({ contentType: "application/ld+json" }),
    ).toBe("json");
    expect(detectKind({ contentType: "text/markdown" })).toBe("markdown");
    expect(detectKind({ contentType: "text/plain" })).toBe("text");
  });

  test("falls back to file extension", () => {
    expect(detectKind({ fileName: "report.PDF" })).toBe("pdf");
    expect(detectKind({ fileName: "memo.docx" })).toBe("docx");
    expect(detectKind({ fileName: "memo.DOC" })).toBe("doc");
    expect(detectKind({ fileName: "page.htm" })).toBe("html");
    expect(detectKind({ fileName: "data.json" })).toBe("json");
    expect(detectKind({ fileName: "notes.md" })).toBe("markdown");
    expect(detectKind({ fileName: "log.txt" })).toBe("text");
  });

  test("returns unknown when no signal", () => {
    expect(detectKind({})).toBe("unknown");
    expect(detectKind({ fileName: "no-extension" })).toBe("unknown");
    expect(detectKind({ contentType: "application/octet-stream" })).toBe(
      "unknown",
    );
  });
});

describe("htmlToPlainText", () => {
  test("strips tags and decodes entities", () => {
    const html = `<html><head><style>body{color:red}</style></head>
<body>
  <h1>Title</h1>
  <p>Hello&nbsp;world &amp; friends.</p>
  <script>alert('x')</script>
  <p>Second &#x4E2D;&#x6587; paragraph.</p>
</body></html>`;
    const text = htmlToPlainText(html);
    expect(text).toContain("Title");
    expect(text).toContain("Hello world & friends.");
    expect(text).toContain("Second 中文 paragraph.");
    expect(text).not.toContain("<");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
  });

  test("handles paragraph breaks via block-level tags", () => {
    const html = "<p>One</p><p>Two</p><div>Three</div><br/>Four";
    const text = htmlToPlainText(html);
    expect(text.split(/\n+/).length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// loadDocument — local files
// ---------------------------------------------------------------------------

describe("loadDocument: local files", () => {
  test("reads UTF-8 text files", async () => {
    const path = join(workDir, "notes.txt");
    await writeFile(path, "hello text world\n你好世界", "utf8");
    const doc = await loadDocument(path);
    expect(doc.kind).toBe("text");
    expect(doc.sourceType).toBe("file");
    expect(doc.fileName).toBe("notes.txt");
    expect(doc.text).toContain("hello text world");
    expect(doc.text).toContain("你好世界");
    expect(doc.bytes).toBeGreaterThan(0);
  });

  test("reads markdown files preserving formatting", async () => {
    const path = join(workDir, "doc.md");
    await writeFile(path, "# Title\n\n- item one\n- item two\n", "utf8");
    const doc = await loadDocument(path);
    expect(doc.kind).toBe("markdown");
    expect(doc.text).toContain("# Title");
    expect(doc.text).toContain("- item one");
  });

  test("strips HTML and produces plain text", async () => {
    const path = join(workDir, "page.html");
    await writeFile(
      path,
      "<html><body><h1>Hi</h1><p>Body &amp; tail</p></body></html>",
      "utf8",
    );
    const doc = await loadDocument(path);
    expect(doc.kind).toBe("html");
    expect(doc.text).toContain("Hi");
    expect(doc.text).toContain("Body & tail");
    expect(doc.text).not.toContain("<");
  });

  test("pretty-prints JSON files", async () => {
    const path = join(workDir, "data.json");
    await writeFile(path, '{"a":1,"b":[2,3]}', "utf8");
    const doc = await loadDocument(path);
    expect(doc.kind).toBe("json");
    expect(doc.text).toContain('"a": 1');
    expect(doc.text).toContain('"b"');
  });

  test("forceKind override is respected", async () => {
    const path = join(workDir, "ambiguous.bin");
    await writeFile(path, "plain ascii bytes", "utf8");
    const doc = await loadDocument(path, { forceKind: "text" });
    expect(doc.kind).toBe("text");
    expect(doc.text).toBe("plain ascii bytes");
  });

  test("rejects missing files with a clear error", async () => {
    await expect(loadDocument(join(workDir, "missing.txt"))).rejects.toThrow(
      /file not found/i,
    );
  });

  test("rejects empty extracted text", async () => {
    const path = join(workDir, "empty.txt");
    await writeFile(path, "   \n   ", "utf8");
    await expect(loadDocument(path)).rejects.toThrow(/no text extracted/i);
  });

  test("rejects oversize files", async () => {
    const path = join(workDir, "big.txt");
    await writeFile(path, "x".repeat(2048), "utf8");
    await expect(loadDocument(path, { maxBytes: 1024 })).rejects.toThrow(
      /too large/i,
    );
  });

  test("rejects legacy .doc with helpful message", async () => {
    const path = join(workDir, "legacy.doc");
    // OLE compound file magic 0xD0CF11E0
    await writeFile(path, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]));
    await expect(loadDocument(path)).rejects.toThrow(/legacy \.doc/i);
  });
});

// ---------------------------------------------------------------------------
// loadDocument — PDF
// ---------------------------------------------------------------------------

function buildMinimalPdf(text: string): Buffer {
  const objects: Array<{ id: number; body: string }> = [];
  function obj(body: string): number {
    const id = objects.length + 1;
    objects.push({ id, body });
    return id;
  }
  const fontId = obj(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  );
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const contentsId = obj(
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  );
  const pageId = obj(
    `<< /Type /Page /Parent __PARENT__ /MediaBox [0 0 612 792] /Contents ${contentsId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
  );
  const pagesId = obj(
    `<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`,
  );
  const catalogId = obj(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  // Patch parent reference now we know pagesId
  const pageObj = objects[pageId - 1];
  if (pageObj) {
    pageObj.body = pageObj.body.replace("__PARENT__", `${pagesId} 0 R`);
  }

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const { id, body } of objects) {
    offsets.push(Buffer.byteLength(pdf, "binary"));
    pdf += `${id} 0 obj\n${body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
}

describe("loadDocument: PDF", () => {
  test("extracts text from a real minimal PDF", async () => {
    const path = join(workDir, "sample.pdf");
    await writeFile(path, buildMinimalPdf("Hello PDF World"));
    const doc = await loadDocument(path);
    expect(doc.kind).toBe("pdf");
    expect(doc.text.replace(/\s+/g, " ")).toContain("Hello PDF World");
    expect(doc.metadata.parser).toBe("unpdf");
    expect(doc.metadata.pageCount).toBe(1);
    expect(doc.bytes).toBeGreaterThan(100);
  }, 30_000);

  test("detects PDF via magic bytes when extension is wrong", async () => {
    const path = join(workDir, "looks-like-text.bin");
    await writeFile(path, buildMinimalPdf("Magic Detected"));
    const doc = await loadDocument(path);
    expect(doc.kind).toBe("pdf");
    expect(doc.text.replace(/\s+/g, " ")).toContain("Magic Detected");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// loadDocument — DOCX
// ---------------------------------------------------------------------------

async function buildMinimalDocx(text: string): Promise<Buffer> {
  // jszip is a transitive dep of mammoth; we reach in via dynamic import to
  // avoid declaring it as a top-level dependency just for tests.
  const JSZipMod: typeof import("jszip") = (await import(
    "jszip"
  )) as unknown as typeof import("jszip");
  const JSZip =
    (JSZipMod as unknown as { default?: typeof import("jszip") }).default ??
    JSZipMod;
  const zip = new (JSZip as unknown as { new (): InstanceType<typeof JSZip> })();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  const relsFolder = zip.folder("_rels");
  relsFolder?.file(
    ".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  const wordFolder = zip.folder("word");
  wordFolder?.file(
    "document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${text}</w:t></w:r></w:p>
  </w:body>
</w:document>`,
  );
  return await zip.generateAsync({ type: "nodebuffer" });
}

describe("loadDocument: DOCX", () => {
  test("extracts raw text from a minimal docx", async () => {
    const path = join(workDir, "sample.docx");
    await writeFile(path, await buildMinimalDocx("Hello DOCX World"));
    const doc = await loadDocument(path);
    expect(doc.kind).toBe("docx");
    expect(doc.text).toContain("Hello DOCX World");
    expect(doc.metadata.parser).toBe("mammoth");
  }, 30_000);

  test("detects docx via magic bytes when extension is wrong", async () => {
    const path = join(workDir, "renamed.bin");
    await writeFile(path, await buildMinimalDocx("Magic DOCX"));
    const doc = await loadDocument(path);
    expect(doc.kind).toBe("docx");
    expect(doc.text).toContain("Magic DOCX");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// loadDocument — URL
// ---------------------------------------------------------------------------

describe("loadDocument: URL", () => {
  test("downloads, infers filename and kind from content-type", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: unknown) => {
        const url = typeof input === "string" ? input : (input as URL).toString();
        const body = "Plain text from URL";
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "content-length": String(Buffer.byteLength(body, "utf8")),
          },
        });
      }) as unknown as typeof fetch;

      const doc = await loadDocument("https://example.com/notes");
      expect(doc.sourceType).toBe("url");
      expect(doc.kind).toBe("text");
      expect(doc.text).toContain("Plain text from URL");
      expect(doc.fileName).toMatch(/example\.com\.txt|notes/);
      expect(doc.mimeType).toContain("text/plain");
      expect(doc.source).toBe("https://example.com/notes");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("respects Content-Disposition filename header", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response("hi", {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "content-disposition": 'attachment; filename="my-report.txt"',
          },
        })) as unknown as typeof fetch;

      const doc = await loadDocument("https://example.com/x");
      expect(doc.fileName).toBe("my-report.txt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("raises a clear error on HTTP failure", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response("nope", {
          status: 404,
          statusText: "Not Found",
        })) as unknown as typeof fetch;

      await expect(loadDocument("https://example.com/missing")).rejects.toThrow(
        /HTTP 404/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("downloaded PDFs are routed through the PDF extractor", async () => {
    const pdf = buildMinimalPdf("Remote PDF Body");
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(pdf, {
          status: 200,
          headers: { "content-type": "application/pdf" },
        })) as unknown as typeof fetch;

      const doc = await loadDocument("https://example.com/file.pdf");
      expect(doc.kind).toBe("pdf");
      expect(doc.text.replace(/\s+/g, " ")).toContain("Remote PDF Body");
      expect(doc.metadata.pageCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 30_000);

  test("rejects oversize remote payloads via content-length", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response("x", {
          status: 200,
          headers: { "content-length": "9999" },
        })) as unknown as typeof fetch;

      await expect(
        loadDocument("https://example.com/big", { maxBytes: 100 }),
      ).rejects.toThrow(/too large/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
