import { describe, expect, test } from "bun:test";
import {
  extractTimelineLines,
  extractWikiStyleLinks,
  parsePageMarkdown,
  renderPageMarkdown,
} from "./parser";

// ---------------------------------------------------------------------------
// parsePageMarkdown
// ---------------------------------------------------------------------------

describe("parsePageMarkdown", () => {
  test("splits compiled truth and timeline on horizontal rule", () => {
    const input = `---
title: T
type: note
---
Line one

---

- **2025-01-01** | event — Timeline here
`;
    const parsed = parsePageMarkdown(input);
    expect(parsed.compiledTruth).toContain("Line one");
    expect(parsed.timeline).toContain("Timeline here");
    expect(parsed.frontmatter.title).toBe("T");
  });

  test("parses frontmatter correctly", () => {
    const input = `---
title: My Title
type: person
tags:
  - alpha
  - beta
custom: 42
---
Content here
`;
    const parsed = parsePageMarkdown(input);
    expect(parsed.frontmatter.title).toBe("My Title");
    expect(parsed.frontmatter.type).toBe("person");
    expect(parsed.frontmatter.tags).toEqual(["alpha", "beta"]);
    expect(parsed.frontmatter.custom).toBe(42);
  });

  test("handles missing frontmatter", () => {
    const parsed = parsePageMarkdown("Just plain content");
    expect(parsed.compiledTruth).toBe("Just plain content");
    expect(parsed.timeline).toBe("");
    expect(parsed.frontmatter).toEqual({});
  });

  test("treats a leading horizontal rule as body when there is no metadata", () => {
    const input = `---

Body that intentionally starts after a horizontal rule.
`;
    const parsed = parsePageMarkdown(input);
    expect(parsed.compiledTruth).toBe(input.trim());
    expect(parsed.timeline).toBe("");
    expect(parsed.frontmatter).toEqual({});
  });

  test("does not split ordinary horizontal rules into timeline", () => {
    const input = `---
title: HR Body
---
Intro

---

More body after a markdown horizontal rule.
`;
    const parsed = parsePageMarkdown(input);
    expect(parsed.compiledTruth).toContain("Intro");
    expect(parsed.compiledTruth).toContain("More body after a markdown horizontal rule.");
    expect(parsed.timeline).toBe("");
  });

  test("handles empty input", () => {
    const parsed = parsePageMarkdown("");
    expect(parsed.compiledTruth).toBe("");
    expect(parsed.timeline).toBe("");
    expect(parsed.frontmatter).toEqual({});
  });

  test("handles frontmatter-only input", () => {
    const input = `---
title: Only FM
---`;
    const parsed = parsePageMarkdown(input);
    expect(parsed.compiledTruth).toBe("");
    expect(parsed.timeline).toBe("");
    expect(parsed.frontmatter.title).toBe("Only FM");
  });

  test("no timeline when no split marker", () => {
    const input = `---
title: No Timeline
---
Some content without timeline
`;
    const parsed = parsePageMarkdown(input);
    expect(parsed.compiledTruth).toBe("Some content without timeline");
    expect(parsed.timeline).toBe("");
  });

  test("timeline preserves multi-line content", () => {
    const input = `---
title: T
---
Main content

---

- **2025-01-01** | event — First event
- **2025-02-01** | meeting — Second event
`;
    const parsed = parsePageMarkdown(input);
    expect(parsed.timeline).toContain("2025-01-01");
    expect(parsed.timeline).toContain("2025-02-01");
  });

  test("handles multiple paragraphs in compiled truth", () => {
    const input = `---
title: Multi
---
Paragraph one.

Paragraph two.

Paragraph three.
`;
    const parsed = parsePageMarkdown(input);
    expect(parsed.compiledTruth).toContain("Paragraph one.");
    expect(parsed.compiledTruth).toContain("Paragraph two.");
    expect(parsed.compiledTruth).toContain("Paragraph three.");
  });
});

// ---------------------------------------------------------------------------
// renderPageMarkdown
// ---------------------------------------------------------------------------

describe("renderPageMarkdown", () => {
  test("round-trips basic page", () => {
    const fm = { title: "Test", type: "note" };
    const truth = "Content here";
    const timeline = "- **2025-01-01** | event — Something";
    const rendered = renderPageMarkdown(fm, truth, timeline);
    expect(rendered).toContain("---\ntitle: Test\ntype: note\n---");
    expect(rendered).toContain("Content here");
    expect(rendered).toContain("2025-01-01");
  });

  test("omits timeline section when empty", () => {
    const rendered = renderPageMarkdown({ title: "T" }, "body", "");
    expect(rendered).not.toContain("---\n\n---");
  });

  test("omits body when empty but has timeline", () => {
    const rendered = renderPageMarkdown({ title: "T" }, "", "timeline");
    expect(rendered).toContain("---");
    expect(rendered).toContain("T");
  });

  test("handles all empty", () => {
    const rendered = renderPageMarkdown({}, "", "");
    expect(typeof rendered).toBe("string");
  });

  test("preserves all frontmatter keys", () => {
    const fm = { title: "A", type: "B", tags: ["x", "y"], custom: 123 };
    const rendered = renderPageMarkdown(fm, "body", "");
    expect(rendered).toContain("title: A");
    expect(rendered).toContain("type: B");
    expect(rendered).toContain("custom: 123");
  });
});

// ---------------------------------------------------------------------------
// extractWikiStyleLinks
// ---------------------------------------------------------------------------

describe("extractWikiStyleLinks", () => {
  test("finds markdown wiki links to .md", () => {
    const md = "See [x](../people/foo.md) and [y](./bar.md).";
    expect(extractWikiStyleLinks(md)).toEqual([
      "../people/foo.md",
      "./bar.md",
    ]);
  });

  test("returns empty array when no links", () => {
    expect(extractWikiStyleLinks("No links here")).toEqual([]);
  });

  test("finds multiple links on same line", () => {
    const md = "[a](x.md) [b](y.md) [c](z.md)";
    expect(extractWikiStyleLinks(md)).toEqual(["x.md", "y.md", "z.md"]);
  });

  test("ignores non-.md links", () => {
    const md = "[img](photo.jpg) [doc](guide.md) [pdf](readme.pdf)";
    expect(extractWikiStyleLinks(md)).toEqual(["guide.md"]);
  });

  test("handles links with spaces in path", () => {
    const md = "[note](my notes/today.md)";
    expect(extractWikiStyleLinks(md)).toEqual(["my notes/today.md"]);
  });

  test("handles links in list items", () => {
    const md = "- See [ref](../docs/api.md)\n- Also [other](./notes.md)";
    expect(extractWikiStyleLinks(md)).toEqual(["../docs/api.md", "./notes.md"]);
  });
});

// ---------------------------------------------------------------------------
// extractTimelineLines
// ---------------------------------------------------------------------------

describe("extractTimelineLines", () => {
  test("parses GBrain-style timeline bullets", () => {
    const timeline = `
- **2026-04-01** | meeting — Discussed roadmap
`;
    const rows = extractTimelineLines(timeline);
    expect(rows).toEqual([
      { date: "2026-04-01", source: "meeting", summary: "Discussed roadmap" },
    ]);
  });

  test("returns empty array for empty input", () => {
    expect(extractTimelineLines("")).toEqual([]);
  });

  test("returns empty array for non-matching lines", () => {
    expect(extractTimelineLines("random text\nno dashes here")).toEqual([]);
  });

  test("parses multiple timeline entries", () => {
    const timeline = `
- **2025-01-01** | release — v1.0 launched
- **2025-03-15** | meeting — Planning session
- **2025-06-20** | release — v2.0 shipped
`;
    const rows = extractTimelineLines(timeline);
    expect(rows).toHaveLength(3);
    expect(rows[0].date).toBe("2025-01-01");
    expect(rows[1].date).toBe("2025-03-15");
    expect(rows[2].date).toBe("2025-06-20");
  });

  test("skips non-timeline lines in mixed content", () => {
    const timeline = `
Some intro text

- **2025-01-01** | event — Something happened

More text
`;
    const rows = extractTimelineLines(timeline);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe("2025-01-01");
  });

  test("handles hyphen as separator (em-dash alternative)", () => {
    const timeline = "- **2025-01-01** | release - v1.0";
    const rows = extractTimelineLines(timeline);
    expect(rows).toEqual([
      { date: "2025-01-01", source: "release", summary: "v1.0" },
    ]);
  });

  test("trims whitespace from source and summary", () => {
    const timeline = "- **2025-01-01** |  release   —  Something happened  ";
    const rows = extractTimelineLines(timeline);
    expect(rows[0].source).toBe("release");
    expect(rows[0].summary).toBe("Something happened");
  });

  test("requires YYYY-MM-DD date format", () => {
    expect(
      extractTimelineLines("- **01/01/2025** | event — test"),
    ).toEqual([]);
    expect(
      extractTimelineLines("- **2025-1-1** | event — test"),
    ).toEqual([]);
    expect(
      extractTimelineLines("- **2025-01-01** | event — valid"),
    ).toHaveLength(1);
  });
});
