import type { ResolvedLLM } from "../settings";
import type { TimelineEntry } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TimelineExtractionInput {
  /** Content to extract timeline from */
  content: string;
  /** Source identifier */
  source: string;
  /** Default date if no date found */
  defaultDate: string;
  /** Page slug for timeline entries */
  pageSlug: string;
}

export interface TimelineExtractionResult {
  /** Extracted timeline entries */
  entries: TimelineEntry[];
  /** Whether extraction succeeded */
  success: boolean;
  /** Confidence of extraction */
  confidence: number;
}

export interface EventExtraction {
  /** Event date (ISO or YYYY-MM-DD) */
  date: string;
  /** Event summary */
  summary: string;
  /** Event detail (optional) */
  detail?: string;
  /** Event type classification */
  eventType: "milestone" | "update" | "meeting" | "announcement" | "transaction" | "other";
  /** Importance score */
  importance: number;
}

// ---------------------------------------------------------------------------
// Timeline Extraction
// ---------------------------------------------------------------------------

/**
 * Extract timeline events from unstructured content.
 * Handles various date formats and event descriptions.
 */
export async function extractTimelineEvents(
  input: TimelineExtractionInput,
  llm: ResolvedLLM,
): Promise<TimelineExtractionResult> {
  const apiKey = resolveApiKey(llm);
  if (!apiKey) {
    // Fallback: regex-based extraction
    return fallbackExtract(input);
  }

  const prompt = buildExtractionPrompt(input);
  const resp = await callLLM(llm, prompt, 2048);
  
  if (!resp) {
    return fallbackExtract(input);
  }

  const entries = parseExtractionResponse(resp, input.pageSlug);
  
  return {
    entries,
    success: entries.length > 0,
    confidence: entries.length > 0 ? 0.85 : 0.3,
  };
}

/**
 * Extract timeline events from entity relations.
 * Used when processing entity-link extraction results.
 */
export async function extractTimelineFromRelation(
  relation: {
    from: string;
    to: string;
    relationType: string;
    context: string;
  },
  defaultDate: string,
  pageSlug: string,
  llm: ResolvedLLM,
): Promise<TimelineEntry | null> {
  // Only extract timeline for significant relation types
  const significantTypes = ["invested_in", "acquired", "founder_of", "leader_of", "works_at"];
  if (!significantTypes.includes(relation.relationType)) {
    return null;
  }

  const prompt = buildRelationTimelinePrompt(relation, defaultDate);
  const resp = await callLLM(llm, prompt, 512);
  
  if (!resp) return null;

  const entries = parseExtractionResponse(resp, pageSlug);
  return entries[0] ?? null;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildExtractionPrompt(input: TimelineExtractionInput): string {
  return `Extract timeline events from this content.

## Content
Source: ${input.source}
Default Date (use if no date found): ${input.defaultDate}
Content:
${input.content.slice(0, 4000)}

## Task
Extract ALL significant events worth recording in a timeline. Output ONLY JSON array.

Schema:
[
  {
    "date": "YYYY-MM-DD (extract from content or use default)",
    "summary": "concise one-line summary (max 80 chars)",
    "detail": "optional markdown detail",
    "eventType": "milestone|update|meeting|announcement|transaction|other",
    "importance": 1-5 (5 = most important)
  }
]

Rules:
1. Extract explicit dates from content (formats: "Jan 15", "2024-01-15", "1月15日", "last week", "yesterday", etc.)
2. Convert relative dates to absolute using default date as reference
3. Include: milestones, decisions, meetings, announcements, transactions, status changes
4. Exclude: trivial mentions, routine activities, vague references
5. Importance 5: founding, acquisition, major funding, product launch
6. Importance 3-4: meetings, partnerships, minor updates
7. Importance 1-2: minor mentions, routine status
8. Max 5 entries, prioritized by importance
9. Empty array if no significant events

Examples:
- "River AI closed Series A yesterday" → [{date: "${input.defaultDate}", summary: "River AI closed Series A funding", eventType: "transaction", importance: 5}]
- "We met with the team on Jan 15" → [{date: "2025-01-15", summary: "Met with team", eventType: "meeting", importance: 3}]
- "The company was founded in 2020" → [{date: "2020-01-01", summary: "Company founded", eventType: "milestone", importance: 5}]

/no_think`;
}

function buildRelationTimelinePrompt(
  relation: { from: string; to: string; relationType: string; context: string },
  defaultDate: string,
): string {
  return `Create a timeline entry for this relationship event.

## Relationship
From: ${relation.from}
To: ${relation.to}
Type: ${relation.relationType}
Context: ${relation.context}
Default Date: ${defaultDate}

## Task
Output ONLY JSON array (single entry or empty).

[
  {
    "date": "YYYY-MM-DD",
    "summary": "concise summary (max 80 chars)",
    "detail": "",
    "eventType": "milestone|update|transaction",
    "importance": 1-5
  }
]

Rules:
1. Extract date from context if mentioned
2. Summarize the relationship event factually
3. Empty array if context is vague or lacks timing

Examples:
- "John founded the company in 2019" → [{date: "2019-01-01", summary: "${relation.from} founded ${relation.to}", importance: 5}]
- "She joined as CEO last month" → [{date: "${defaultDate}", summary: "${relation.from} became CEO of ${relation.to}", importance: 4}]

/no_think`;
}

// ---------------------------------------------------------------------------
// LLM Call
// ---------------------------------------------------------------------------

async function callLLM(llm: ResolvedLLM, prompt: string, maxTokens: number): Promise<string> {
  const apiKey = resolveApiKey(llm);
  if (!apiKey) return "";

  const body = {
    model: llm.model,
    messages: [
      { role: "system", content: "You are a timeline extraction assistant. Extract events from unstructured text. Always output valid JSON array. Be concise and factual." },
      { role: "user", content: prompt },
    ],
    temperature: 0.1,
    max_tokens: maxTokens,
    enable_thinking: false,
  };

  try {
    const resp = await fetch(
      llm.baseURL.endsWith("/") ? llm.baseURL + "chat/completions" : llm.baseURL + "/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      },
    );

    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`[timeline-extractor] LLM call failed (${resp.status}): ${text.slice(0, 200)}`);
      return "";
    }

    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[timeline-extractor] LLM call error: ${msg}`);
    return "";
  }
}

// ---------------------------------------------------------------------------
// Response Parsing
// ---------------------------------------------------------------------------

function parseExtractionResponse(resp: string, pageSlug: string): TimelineEntry[] {
  const match = resp.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[0]) as unknown[];
    const entries: TimelineEntry[] = [];
    
    for (const e of parsed) {
      if (typeof e !== "object" || e === null) continue;
      const entry = e as Record<string, unknown>;
      
      const date = normalizeDate(String(entry.date ?? ""));
      if (!date) continue;
      
      entries.push({
        pageSlug,
        date,
        source: "extracted",
        summary: String(entry.summary ?? "").slice(0, 120),
        detail: String(entry.detail ?? ""),
      });
    }
    
    // Sort by date descending
    entries.sort((a, b) => b.date.localeCompare(a.date));
    
    return entries.slice(0, 5); // Max 5 entries per extraction
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fallback Extraction (Regex-based)
// ---------------------------------------------------------------------------

function fallbackExtract(input: TimelineExtractionInput): TimelineExtractionResult {
  const entries: TimelineEntry[] = [];
  const content = input.content;
  
  // Common date patterns
  const datePatterns = [
    // ISO: 2024-01-15
    /\b(\d{4}-\d{2}-\d{2})\b/g,
    // Chinese: 2024年1月15日, 1月15日
    /\b(\d{4}年\d{1,2}月\d{1,2}日)\b/g,
    /\b(\d{1,2}月\d{1,2}日)\b/g,
    // English: Jan 15, January 15, Jan 15th
    /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)\b/gi,
    // Relative: yesterday, last week, last month
    /\b(yesterday|last\s+week|last\s+month|recently)\b/gi,
  ];

  // Try to find dates and extract surrounding context
  for (const pattern of datePatterns) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      if (!match[1]) continue;
      
      const rawDate = match[1];
      const normalizedDate = normalizeDate(rawDate, input.defaultDate);
      if (!normalizedDate) continue;
      
      // Extract context around the date (up to 100 chars before and after)
      const start = Math.max(0, match.index! - 100);
      const end = Math.min(content.length, match.index! + match[0].length + 100);
      const context = content.slice(start, end).trim();
      
      // Create a summary from the context
      const summary = context.slice(0, 80).replace(/\n+/g, " ").trim();
      
      if (summary.length > 10) {
        entries.push({
          pageSlug: input.pageSlug,
          date: normalizedDate,
          source: input.source,
          summary,
          detail: "",
        });
      }
    }
  }

  // Deduplicate by date + summary similarity
  const uniqueEntries = deduplicateEntries(entries);
  
  return {
    entries: uniqueEntries,
    success: uniqueEntries.length > 0,
    confidence: 0.4, // Lower confidence for regex fallback
  };
}

// ---------------------------------------------------------------------------
// Date Normalization
// ---------------------------------------------------------------------------

function normalizeDate(raw: string, defaultDate?: string): string {
  const trimmed = raw.trim();
  
  // Already ISO format
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  // Chinese format: 2024年1月15日
  const chineseMatch = trimmed.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (chineseMatch) {
    const [, year, month, day] = chineseMatch;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  // Chinese format without year: 1月15日
  const chineseNoYearMatch = trimmed.match(/(\d{1,2})月(\d{1,2})日/);
  if (chineseNoYearMatch && defaultDate) {
    const [, month, day] = chineseNoYearMatch;
    const year = defaultDate.slice(0, 4);
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  // English month names
  const monthMap: Record<string, string> = {
    jan: "01", january: "01",
    feb: "02", february: "02",
    mar: "03", march: "03",
    apr: "04", april: "04",
    may: "05",
    jun: "06", june: "06",
    jul: "07", july: "07",
    aug: "08", august: "08",
    sep: "09", september: "09",
    oct: "10", october: "10",
    nov: "11", november: "11",
    dec: "12", december: "12",
  };

  const englishMatch = trimmed.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i);
  if (englishMatch) {
    const [, monthName, day, year] = englishMatch;
    const month = monthMap[monthName.toLowerCase().slice(0, 3)];
    if (month) {
      const finalYear = year || (defaultDate ? defaultDate.slice(0, 4) : new Date().getFullYear().toString());
      return `${finalYear}-${month}-${day.padStart(2, "0")}`;
    }
  }

  // Relative dates
  if (/yesterday/i.test(trimmed) && defaultDate) {
    const d = new Date(defaultDate);
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  if (/last\s+week/i.test(trimmed) && defaultDate) {
    const d = new Date(defaultDate);
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  }

  if (/last\s+month/i.test(trimmed) && defaultDate) {
    const d = new Date(defaultDate);
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 10);
  }

  if (/recently/i.test(trimmed) && defaultDate) {
    return defaultDate;
  }

  // Default date fallback
  if (defaultDate) {
    return defaultDate;
  }

  return "";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveApiKey(llm: ResolvedLLM): string {
  if (llm.apiKey) return llm.apiKey;
  if (llm.apiKeyEnv) return process.env[llm.apiKeyEnv] ?? "";
  return "";
}

function deduplicateEntries(entries: TimelineEntry[]): TimelineEntry[] {
  const seen = new Map<string, TimelineEntry>();
  
  for (const entry of entries) {
    const key = `${entry.date}:${entry.summary.slice(0, 50)}`;
    if (!seen.has(key)) {
      seen.set(key, entry);
    }
  }
  
  return Array.from(seen.values());
}