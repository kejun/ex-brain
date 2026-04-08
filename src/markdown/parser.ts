import matter from "gray-matter";

export interface ParsedMarkdownPage {
  frontmatter: Record<string, unknown>;
  compiledTruth: string;
  timeline: string;
}

const SPLIT_MARKER = /^-{3,}\s*$/m;

export function parsePageMarkdown(input: string): ParsedMarkdownPage {
  const parsed = matter(input);
  const content = parsed.content.trim();
  const [compiledTruth, timeline] = splitCompiledAndTimeline(content);
  return {
    frontmatter: (parsed.data ?? {}) as Record<string, unknown>,
    compiledTruth: compiledTruth.trim(),
    timeline: timeline.trim(),
  };
}

export function renderPageMarkdown(
  frontmatter: Record<string, unknown>,
  compiledTruth: string,
  timeline: string,
): string {
  const body = [compiledTruth.trim(), "---", timeline.trim()]
    .filter((part) => part.length > 0)
    .join("\n\n");
  return matter.stringify(body, frontmatter);
}

function splitCompiledAndTimeline(content: string): [string, string] {
  const match = SPLIT_MARKER.exec(content);
  if (!match || match.index === undefined) {
    return [content, ""];
  }
  const left = content.slice(0, match.index);
  const right = content.slice(match.index + match[0].length);
  return [left, right];
}

export function extractWikiStyleLinks(content: string): string[] {
  const regex = /\[[^\]]+\]\(([^)]+\.md)\)/g;
  const links: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    if (m[1]) {
      links.push(m[1]);
    }
  }
  return links;
}

export function extractTimelineLines(
  timelineMarkdown: string,
): Array<{ date: string; source: string; summary: string }> {
  const lines = timelineMarkdown.split("\n");
  const results: Array<{ date: string; source: string; summary: string }> = [];
  const re = /^\s*-\s+\*\*(\d{4}-\d{2}-\d{2})\*\*\s*\|\s*([^—-]+)[—-]\s*(.+)$/;
  for (const line of lines) {
    const m = line.match(re);
    if (m) {
      results.push({
        date: m[1],
        source: m[2].trim(),
        summary: m[3].trim(),
      });
    }
  }
  return results;
}
