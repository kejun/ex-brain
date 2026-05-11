/**
 * Intelligent Compilation — AIPipeline version.
 *
 * Uses AIPipeline for LLM call lifecycle (createAxAI → forward → parse → transform → fallback).
 * Two pipeline instances: compileTruth + extractTimeline (both use AIPipeline).
 *
 * Public API unchanged — drop-in replacement for callers.
 */

import { f } from "@ax-llm/ax";
import type { ResolvedLLM } from "../settings";
import type { TimelineEntry } from "../types";
import { AIPipeline, parseJsonObject } from "./ax-pipeline";

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
// Compile pipeline configuration
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

interface ParsedCompileResult {
  changeType: CompileResult["changeType"];
  compiledTruth: string;
  changeSummary: string;
  confidence: number;
}

function parseCompileResult(raw: unknown): ParsedCompileResult | null {
  const obj = parseJsonObject(raw);
  if (!obj) return null;

  const changeType = String(obj.changeType ?? "none");
  const validTypes = ["append", "update", "replace", "none", "conflict"];
  const normalizedType = validTypes.includes(changeType)
    ? changeType as CompileResult["changeType"]
    : "append";

  const compiledTruth = String(obj.compiledTruth ?? "");
  if (!compiledTruth) return null;

  return {
    changeType: normalizedType,
    compiledTruth,
    changeSummary: String(obj.changeSummary ?? ""),
    confidence: typeof obj.confidence === "number" ? obj.confidence : 0.8,
  };
}

const compilePipeline = new AIPipeline<CompileInput, ParsedCompileResult, {
  parsed: ParsedCompileResult;
  timelineEntries: TimelineEntry[];
}>({
  signature: compileSig,
  mapInput: (input) => ({
    currentTruth: input.currentTruth || "(empty)",
    newInfo: input.newInfo,
    infoSource: input.source,
    infoDate: input.date,
    context: buildContext(input),
  }),
  extractOutput: (raw) => raw.compilationResult,
  parseRaw: parseCompileResult,
  transform: (_parsed, _input) => ({ parsed: _parsed, timelineEntries: [] }),
  fallback: fallbackAppend,
  label: "Ax compilation",
});

// ---------------------------------------------------------------------------
// Timeline extraction pipeline (used internally by compileTruth)
// ---------------------------------------------------------------------------

const timelineSig = f()
  .input("newInfo", f.string("Information to extract timeline events from"))
  .input("infoSource", f.string("Source identifier"))
  .input("infoDate", f.string("Date of the information in YYYY-MM-DD format"))
  .output("events", f.json(
    "Array of timeline events with: date (YYYY-MM-DD), summary (max 120 chars), detail (optional)"
  ))
  .build();

interface TimelineExtractInput {
  newInfo: string;
  infoSource: string;
  infoDate: string;
  pageSlug: string;
}

interface RawEvent { date?: string; summary?: string; detail?: string; }

function parseEvents(raw: unknown): RawEvent[] {
  if (Array.isArray(raw)) return raw as RawEvent[];
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as RawEvent[]; } catch { return []; }
  }
  return [];
}

const timelinePipeline = new AIPipeline<TimelineExtractInput, RawEvent[], TimelineEntry[]>({
  signature: timelineSig,
  mapInput: (input) => ({
    newInfo: input.newInfo,
    infoSource: input.infoSource,
    infoDate: input.infoDate,
  }),
  extractOutput: (raw) => raw.events,
  parseRaw: parseEvents,
  transform: (rawEvents, input) => rawEvents.map(e => ({
    pageSlug: input.pageSlug,
    date: String(e.date ?? input.infoDate),
    source: input.infoSource,
    summary: String(e.summary ?? "").slice(0, 120),
    detail: String(e.detail ?? ""),
  })),
  fallback: () => [],
  label: "Ax timeline extraction",
});

// ---------------------------------------------------------------------------
// Public API (unchanged)
// ---------------------------------------------------------------------------

export async function compileTruth(
  input: CompileInput,
  llm: ResolvedLLM,
): Promise<CompileResult> {
  // Step 1: Main compilation via AIPipeline
  const result = await compilePipeline.run(input, llm);

  // If fallback was triggered, pipeline returns the full CompileResult
  if ("compiledTruth" in result && !("parsed" in result)) {
    return result as CompileResult;
  }

  // Step 2: Extract timeline entries via AIPipeline
  const timelineInput: TimelineExtractInput = {
    newInfo: input.newInfo,
    infoSource: input.source,
    infoDate: input.date,
    pageSlug: input.pageContext?.slug ?? "",
  };
  const timelineEntries = await timelinePipeline.run(timelineInput, llm);

  const compiled = result.parsed;
  return {
    compiledTruth: compiled.compiledTruth,
    changed: compiled.changeType !== "none",
    changeType: compiled.changeType,
    changeSummary: compiled.changeSummary,
    timelineEntries,
    confidence: compiled.confidence,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
