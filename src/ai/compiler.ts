/**
 * Intelligent Compilation — Ax Signature version.
 *
 * Uses f.json() for complex multi-line output (compiledTruth contains markdown
 * with multiple lines, which breaks Ax's line-based field parsing).
 *
 * Features:
 * - Declaraive input/output contracts
 * - Automatic validation + retry on failure
 * - Ready for GEPA optimization
 * - Fallback to append when LLM unavailable
 */

import { ax, f } from "@ax-llm/ax";
import type { ResolvedLLM } from "../settings";
import type { TimelineEntry } from "../types";
import { createAxAI } from "./ax-adapter";

// ---------------------------------------------------------------------------
// Types (preserved for API compatibility with BrainRepository)
// ---------------------------------------------------------------------------

export interface CompileInput {
  currentTruth: string;
  timeline: TimelineEntry[];
  newInfo: string;
  source: string;
  date: string;
  pageContext?: { slug: string; type: string; title: string };
}

export interface CompileResult {
  compiledTruth: string;
  changed: boolean;
  changeType: "append" | "update" | "replace" | "none" | "conflict";
  changeSummary: string;
  timelineEntries: TimelineEntry[];
  confidence: number;
}

// ---------------------------------------------------------------------------
// Signature definition (using json for multi-line compiledTruth)
// ---------------------------------------------------------------------------

const compileSig = f()
  .input("currentTruth", f.string("Current compiled truth content"))
  .input("newInfo", f.string("New information to compile"))
  .input("infoSource", f.string("Source of the new information"))
  .input("infoDate", f.string("Date of the new information in YYYY-MM-DD format"))
  .input("context", f.string("Page type, title, and recent timeline for context"))
  .output("compilationResult", f.json(
    "Compilation result as JSON object with: " +
    "changeType (append|update|replace|none|conflict), " +
    "compiledTruth (full updated markdown), " +
    "changeSummary (one-line summary), " +
    "confidence (0-1)"
  ))
  .build();

const compileGen = ax(compileSig);

// Timeline extraction sub-signature
const timelineSig = f()
  .input("newInfo", f.string("Information to extract timeline events from"))
  .input("infoSource", f.string("Source identifier"))
  .input("infoDate", f.string("Date of the information in YYYY-MM-DD format"))
  .output("events", f.json(
    "Array of timeline events with: date (YYYY-MM-DD), summary (max 120 chars), detail (optional)"
  ))
  .build();

const timelineGen = ax(timelineSig);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function compileTruth(
  input: CompileInput,
  llm: ResolvedLLM,
): Promise<CompileResult> {
  const aiClient = createAxAI(llm);
  if (!aiClient) return fallbackAppend(input);

  try {
    // Step 1: Main compilation
    const context = buildContext(input);
    const result = await compileGen.forward(aiClient, {
      currentTruth: input.currentTruth || "(empty)",
      newInfo: input.newInfo,
      infoSource: input.source,
      infoDate: input.date,
      context,
    });

    // Parse the JSON result
    const compiled = parseCompileResult(result.compilationResult);
    if (!compiled) return fallbackAppend(input);

    // Step 2: Extract timeline entries
    const timelineEntries = await extractTimeline(input, aiClient);

    return {
      compiledTruth: compiled.compiledTruth,
      changed: compiled.changeType !== "none",
      changeType: compiled.changeType,
      changeSummary: compiled.changeSummary,
      timelineEntries,
      confidence: compiled.confidence,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[ebrain] Ax compilation failed, falling back to append: ${msg}`);
    return fallbackAppend(input);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ParsedCompileResult {
  changeType: CompileResult["changeType"];
  compiledTruth: string;
  changeSummary: string;
  confidence: number;
}

function parseCompileResult(raw: unknown): ParsedCompileResult | null {
  let obj: Record<string, unknown>;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { return null; }
  } else if (typeof raw === "object" && raw !== null) {
    obj = raw as Record<string, unknown>;
  } else {
    return null;
  }

  const changeType = String(obj.changeType ?? "none");
  const validTypes = ["append", "update", "replace", "none", "conflict"];
  const normalizedType = validTypes.includes(changeType) ? changeType as CompileResult["changeType"] : "append";

  const compiledTruth = String(obj.compiledTruth ?? "");
  if (!compiledTruth) return null;

  return {
    changeType: normalizedType,
    compiledTruth,
    changeSummary: String(obj.changeSummary ?? ""),
    confidence: typeof obj.confidence === "number" ? obj.confidence : 0.8,
  };
}

function buildContext(input: CompileInput): string {
  const parts: string[] = [];
  if (input.pageContext) {
    parts.push(`Page: ${input.pageContext.title} (${input.pageContext.type})`);
  }
  if (input.timeline.length > 0) {
    const recent = input.timeline.slice(0, 10);
    parts.push("Recent Timeline:");
    parts.push(recent.map(t => `  - ${t.date} | ${t.source}: ${t.summary}`).join("\n"));
  }
  return parts.join("\n\n") || "(no additional context)";
}

async function extractTimeline(
  input: CompileInput,
  aiClient: ReturnType<typeof createAxAI>,
): Promise<TimelineEntry[]> {
  if (!aiClient) return [];
  try {
    const result = await timelineGen.forward(aiClient, {
      newInfo: input.newInfo,
      infoSource: input.source,
      infoDate: input.date,
    });

    const rawEvents = parseEvents(result.events);
    const pageSlug = input.pageContext?.slug ?? "";
    return rawEvents.map(e => ({
      pageSlug,
      date: String(e.date ?? input.date),
      source: input.source,
      summary: String(e.summary ?? "").slice(0, 120),
      detail: String(e.detail ?? ""),
    }));
  } catch {
    return [];
  }
}

interface RawEvent { date?: string; summary?: string; detail?: string; }

function parseEvents(raw: unknown): RawEvent[] {
  if (Array.isArray(raw)) return raw as RawEvent[];
  if (typeof raw === "string") { try { return JSON.parse(raw) as RawEvent[]; } catch { return []; } }
  return [];
}

function fallbackAppend(input: CompileInput): CompileResult {
  const timestamp = input.date || new Date().toISOString().slice(0, 10);
  const newLine = `- ${input.newInfo.trim()} (Source: ${input.source}, ${timestamp})`;
  const current = input.currentTruth || "";
  let compiledTruth: string;
  if (!current.trim()) {
    compiledTruth = `## Facts\n\n${newLine}`;
  } else if (!current.includes("## Facts")) {
    compiledTruth = `${current}\n\n## Facts\n\n${newLine}`;
  } else {
    compiledTruth = `${current}\n${newLine}`;
  }
  return { compiledTruth, changed: true, changeType: "append", changeSummary: "LLM unavailable, appended as simple fact", timelineEntries: [], confidence: 0.5 };
}
