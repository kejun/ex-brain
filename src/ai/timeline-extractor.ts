/**
 * Timeline Extraction — AIPipeline version.
 *
 * Uses AIPipeline for LLM call lifecycle (createAxAI → forward → parse → transform → fallback).
 *
 * Public API unchanged — drop-in replacement for callers.
 */

import { f } from "@ax-llm/ax";
import type { ResolvedLLM } from "../settings";
import type { TimelineEntry } from "../types";
import { AIPipeline, parseJsonArray } from "./ax-pipeline";
import { createAxAI } from "./ax-adapter";

// ---------------------------------------------------------------------------
// Types (preserved for API compatibility)
// ---------------------------------------------------------------------------

export interface TimelineExtractionInput {
  content: string;
  source: string;
  defaultDate: string;
  pageSlug: string;
}

export interface TimelineExtractionResult {
  entries: TimelineEntry[];
  success: boolean;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Timeline pipeline configuration
// ---------------------------------------------------------------------------

const timelineSig = f()
  .input("textContent", f.string("Content to extract timeline events from"))
  .input("infoDate", f.string("YYYY-MM-DD fallback date when no date is found in content"))
  .output("events", f.json(
    "Array of events. Each: { date (YYYY-MM-DD), summary (max 120 chars, Chinese), detail (optional, Chinese), eventType (milestone|update|meeting|announcement|transaction|other), importance (1-5) }"
  ))
  .build();

interface RawEvent {
  date?: string;
  summary?: string;
  detail?: string;
  eventType?: string;
  importance?: number | string;
}

function parseEvents(raw: unknown): RawEvent[] {
  if (Array.isArray(raw)) {
    return raw.map((item: Record<string, unknown>) => ({
      date: String(item.date ?? item.eventDate ?? ''),
      summary: String(item.summary ?? item.eventSummary ?? ''),
      detail: String(item.detail ?? item.description ?? ''),
    })).filter(e => e.date || e.summary);
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>[];
      return parseEvents(parsed);
    } catch { return []; }
  }
  return [];
}

const timelinePipeline = new AIPipeline<
  { textContent: string; infoDate: string },
  RawEvent[],
  RawEvent[]
>({
  signature: timelineSig,
  mapInput: (input) => input,
  extractOutput: (raw) => raw.events,
  parseRaw: parseEvents,
  transform: (raw) => raw,
  fallback: () => [],
  label: "Timeline extraction",
});

// ---------------------------------------------------------------------------
// Date Normalization (preserved from original implementation)
// ---------------------------------------------------------------------------

function normalizeDate(raw: string, defaultDate?: string): string {
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const chineseMatch = trimmed.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (chineseMatch) {
    const [, year, month, day] = chineseMatch;
    if (year && month && day) return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const chineseNoYearMatch = trimmed.match(/(\d{1,2})月(\d{1,2})日/);
  if (chineseNoYearMatch && defaultDate) {
    const [, month, day] = chineseNoYearMatch;
    if (month && day) return `${defaultDate.slice(0, 4)}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const monthMap: Record<string, string> = {
    jan: "01", january: "01", feb: "02", february: "02", mar: "03", march: "03",
    apr: "04", april: "04", may: "05", jun: "06", june: "06", jul: "07", july: "07",
    aug: "08", august: "08", sep: "09", september: "09", oct: "10", october: "10",
    nov: "11", november: "11", dec: "12", december: "12",
  };

  const englishMatch = trimmed.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i);
  if (englishMatch) {
    const [, monthName, day, year] = englishMatch;
    if (monthName && day) {
      const month = monthMap[monthName.toLowerCase().slice(0, 3)];
      if (month) {
        const finalYear = year || (defaultDate ? defaultDate.slice(0, 4) : new Date().getFullYear().toString());
        return `${finalYear}-${month}-${day.padStart(2, "0")}`;
      }
    }
  }

  if (/yesterday/i.test(trimmed) && defaultDate) { const d = new Date(defaultDate); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); }
  if (/last\s+week/i.test(trimmed) && defaultDate) { const d = new Date(defaultDate); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10); }
  if (/last\s+month/i.test(trimmed) && defaultDate) { const d = new Date(defaultDate); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 10); }
  if (/recently/i.test(trimmed) && defaultDate) return defaultDate;

  return defaultDate || "";
}

// ---------------------------------------------------------------------------
// Fallback: Regex-based extraction (no LLM available)
// ---------------------------------------------------------------------------

function fallbackExtract(input: TimelineExtractionInput): TimelineExtractionResult {
  const entries: TimelineEntry[] = [];
  const content = input.content;
  const datePatterns = [
    /\b(\d{4}-\d{2}-\d{2})\b/g,
    /(\d{4}年\d{1,2}月\d{1,2}日)/g,
    /(\d{1,2}月\d{1,2}日)/g,
    /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)\b/gi,
    /\b(yesterday|last\s+week|last\s+month|recently)\b/gi,
  ];

  for (const pattern of datePatterns) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      if (!match[1]) continue;
      const normalizedDate = normalizeDate(match[1], input.defaultDate);
      if (!normalizedDate) continue;
      const start = Math.max(0, match.index! - 100);
      const end = Math.min(content.length, match.index! + match[0].length + 100);
      const ctx = content.slice(start, end).trim();
      const summary = ctx.slice(0, 80).replace(/\n+/g, " ").trim();
      if (summary.length > 10) {
        entries.push({ pageSlug: input.pageSlug, date: normalizedDate, source: input.source, summary, detail: "" });
      }
    }
  }

  const seen = new Map<string, TimelineEntry>();
  for (const entry of entries) {
    const key = `${entry.date}:${entry.summary.slice(0, 50)}`;
    if (!seen.has(key)) seen.set(key, entry);
  }
  const uniqueEntries = Array.from(seen.values());
  return { entries: uniqueEntries, success: uniqueEntries.length > 0, confidence: 0.4 };
}

// ---------------------------------------------------------------------------
// Public API (unchanged)
// ---------------------------------------------------------------------------

export async function extractTimelineEvents(
  input: TimelineExtractionInput,
  llm: ResolvedLLM,
): Promise<TimelineExtractionResult> {
  if (!input.content.trim()) {
    return { entries: [], success: false, confidence: 0.3 };
  }

  const aiClient = createAxAI(llm);
  if (!aiClient) {
    return fallbackExtract(input);
  }

  try {
    const rawEvents = await timelinePipeline.run(
      { textContent: input.content.slice(0, 4000), infoDate: input.defaultDate },
      llm,
    );

    const entries: TimelineEntry[] = [];
    for (const e of rawEvents) {
      const date = normalizeDate(String(e.date ?? ""), input.defaultDate);
      if (!date) continue;

      entries.push({
        pageSlug: input.pageSlug,
        date,
        source: input.source,
        summary: String(e.summary ?? "").slice(0, 120),
        detail: String(e.detail ?? ""),
        importance: Math.max(1, Math.min(5, Math.round(Number(e.importance ?? 3)))),
      });
    }

    entries.sort((a, b) => b.date.localeCompare(a.date));

    return {
      entries: entries.slice(0, 5),
      success: entries.length > 0,
      confidence: entries.length > 0 ? 0.85 : 0.3,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[ebrain] Timeline extraction failed: ${msg}`);
    return fallbackExtract(input);
  }
}

export async function extractTimelineFromRelation(
  relation: { from: string; to: string; relationType: string; context: string },
  defaultDate: string,
  pageSlug: string,
  llm: ResolvedLLM,
): Promise<TimelineEntry | null> {
  const significantTypes = ["invested_in", "acquired", "founder_of", "leader_of", "works_at"];
  if (!significantTypes.includes(relation.relationType)) return null;

  const aiClient = createAxAI(llm);
  if (!aiClient) return null;

  try {
    const content = `${relation.from} → ${relation.to} (${relation.relationType}): ${relation.context}`;
    const rawEvents = await timelinePipeline.run(
      { textContent: content, infoDate: defaultDate },
      llm,
    );

    for (const e of rawEvents) {
      const date = normalizeDate(String(e.date ?? ""), defaultDate);
      if (!date) continue;
      return {
        pageSlug,
        date,
        source: "extracted",
        summary: String(e.summary ?? "").slice(0, 120),
        detail: String(e.detail ?? ""),
        importance: Math.max(1, Math.min(5, Math.round(Number(e.importance ?? 3)))),
      };
    }
    return null;
  } catch {
    return null;
  }
}
