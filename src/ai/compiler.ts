import type { ResolvedLLM } from "../settings";
import type { TimelineEntry } from "../types";
import { callLLM, resolveApiKey } from "./llm-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompileInput {
  /** Current compiled truth content */
  currentTruth: string;
  /** Timeline entries for context */
  timeline: TimelineEntry[];
  /** New information to process */
  newInfo: string;
  /** Source of the new information */
  source: string;
  /** Date of the new information (ISO or YYYY-MM-DD) */
  date: string;
  /** Page metadata for context */
  pageContext?: {
    slug: string;
    type: string;
    title: string;
  };
}

export interface CompileResult {
  /** Updated compiled truth */
  compiledTruth: string;
  /** Whether any update was made */
  changed: boolean;
  /** Type of change */
  changeType: "append" | "update" | "replace" | "none" | "conflict";
  /** Human-readable summary of what changed */
  changeSummary: string;
  /** Timeline entries to add (extracted from new info) */
  timelineEntries: TimelineEntry[];
  /** Confidence score */
  confidence: number;
}

export interface FactAnalysis {
  /** Key facts extracted */
  facts: ExtractedFact[];
  /** Information type classification */
  infoType: "status_update" | "new_event" | "correction" | "confirmation" | "new_entity";
  /** Entities mentioned */
  entities: string[];
  /** Temporal context */
  temporalContext: string;
}

export interface ExtractedFact {
  /** Fact category (e.g., "funding_stage", "valuation", "ceo") */
  category: string;
  /** Previous value (if this is an update) */
  oldValue?: string;
  /** New value */
  newValue: string;
  /** Whether this replaces or adds */
  action: "replace" | "add";
  /** Source sentence */
  sourceSentence: string;
  /** Confidence */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Compile Logic
// ---------------------------------------------------------------------------

/**
 * Intelligent compilation: analyze new info, merge/update compiled truth.
 * Uses LLM to understand semantic changes and update appropriately.
 */
export async function compileTruth(
  input: CompileInput,
  llm: ResolvedLLM,
): Promise<CompileResult> {
  const apiKey = resolveApiKey(llm);
  if (!apiKey) {
    return {
      compiledTruth: appendFact(input.currentTruth, input.newInfo, input.source),
      changed: true,
      changeType: "append",
      changeSummary: "LLM not configured, appended as simple fact",
      timelineEntries: [],
      confidence: 0.5,
    };
  }

  // Step 1: Analyze the new information
  const analysis = await analyzeNewInfo(input, llm);
  
  // Step 2: Generate updated compiled truth
  const updateResult = await generateUpdatedTruth(input, analysis, llm);
  
  // Step 3: Extract timeline entries from new info
  const timelineEntries = await extractTimelineFromInfo(input, analysis, llm);

  return {
    compiledTruth: updateResult.compiledTruth,
    changed: updateResult.changed,
    changeType: updateResult.changeType,
    changeSummary: updateResult.changeSummary,
    timelineEntries,
    confidence: analysis.facts.reduce((sum, f) => sum + f.confidence, 0) / Math.max(analysis.facts.length, 1),
  };
}

/**
 * Step 1: Analyze new information to understand what it means
 */
async function analyzeNewInfo(
  input: CompileInput,
  llm: ResolvedLLM,
): Promise<FactAnalysis> {
  const prompt = buildAnalysisPrompt(input);
  const resp = await callLLM(llm, prompt, 2048, COMPILER_SYSTEM_PROMPT);
  const parsed = parseAnalysisResponse(resp);
  
  return parsed;
}

/**
 * Step 2: Generate updated compiled truth based on analysis
 */
async function generateUpdatedTruth(
  input: CompileInput,
  analysis: FactAnalysis,
  llm: ResolvedLLM,
): Promise<{ compiledTruth: string; changed: boolean; changeType: CompileResult["changeType"]; changeSummary: string }> {
  // If no facts extracted, no change needed
  if (analysis.facts.length === 0) {
    return {
      compiledTruth: input.currentTruth,
      changed: false,
      changeType: "none",
      changeSummary: "No actionable facts extracted",
    };
  }

  // For status updates and corrections, use LLM to intelligently merge
  if (analysis.infoType === "status_update" || analysis.infoType === "correction") {
    return await smartMergeTruth(input, analysis, llm);
  }

  // For new events/entities, append
  if (analysis.infoType === "new_event" || analysis.infoType === "new_entity") {
    return {
      compiledTruth: appendStructuredFacts(input.currentTruth, analysis.facts, input.source),
      changed: true,
      changeType: "append",
      changeSummary: `Added ${analysis.facts.length} new facts`,
    };
  }

  // Default: append with source attribution
  return {
    compiledTruth: appendFact(input.currentTruth, input.newInfo, input.source),
    changed: true,
    changeType: "append",
    changeSummary: "Appended new information with source attribution",
  };
}

/**
 * Smart merge: LLM understands semantic updates and rewrites compiled truth
 */
async function smartMergeTruth(
  input: CompileInput,
  analysis: FactAnalysis,
  llm: ResolvedLLM,
): Promise<{ compiledTruth: string; changed: boolean; changeType: CompileResult["changeType"]; changeSummary: string }> {
  const prompt = buildMergePrompt(input, analysis);
  const resp = await callLLM(llm, prompt, 4096, COMPILER_SYSTEM_PROMPT);
  const result = parseMergeResponse(resp);
  
  return result;
}

/**
 * Step 3: Extract timeline entries from new information
 */
async function extractTimelineFromInfo(
  input: CompileInput,
  analysis: FactAnalysis,
  llm: ResolvedLLM,
): Promise<TimelineEntry[]> {
  // Only extract timeline for significant events
  if (analysis.infoType === "status_update" || analysis.infoType === "new_event") {
    const prompt = buildTimelinePrompt(input, analysis);
    const resp = await callLLM(llm, prompt, 1024, COMPILER_SYSTEM_PROMPT);
    return parseTimelineResponse(resp, input.pageContext?.slug ?? "");
  }
  
  return [];
}

// ---------------------------------------------------------------------------
// Prompt Building
// ---------------------------------------------------------------------------

function buildAnalysisPrompt(input: CompileInput): string {
  return `Analyze the new information and classify what type of update this represents.

## Context
Page: ${input.pageContext?.title ?? "Unknown"} (${input.pageContext?.type ?? "unknown"})
Current Compiled Truth:
${input.currentTruth || "(empty)"}

Recent Timeline (for temporal context):
${input.timeline.slice(0, 10).map(t => `- ${t.date} | ${t.source}: ${t.summary}`).join("\n") || "(no timeline)"}

## New Information
Source: ${input.source}
Date: ${input.date}
Content: ${input.newInfo}

## Task
Classify this information and extract key facts. Output ONLY JSON.

Schema:
{
  "facts": [
    {
      "category": "funding_stage|valuation|ceo|employee_count|product_status|partnership|...",
      "oldValue": "previous value if this updates something (null if new)",
      "newValue": "the new value",
      "action": "replace|add",
      "sourceSentence": "exact sentence from new info",
      "confidence": 0.0-1.0
    }
  ],
  "infoType": "status_update|new_event|correction|confirmation|new_entity",
  "entities": ["list of entities mentioned"],
  "temporalContext": "when this happened or is valid for"
}

Rules:
1. "status_update" = information that changes/updates existing state (e.g., funding stage change)
2. "new_event" = discrete event that happened (e.g., product launch)
3. "correction" = explicitly correcting previous information
4. "confirmation" = confirming existing information without change
5. "new_entity" = introducing new entity/aspect not previously tracked
6. Extract ALL actionable facts, not just the most prominent one
7. Use high confidence (0.8+) for clear, explicit statements; lower for ambiguous ones

/no_think`;
}

function buildMergePrompt(input: CompileInput, analysis: FactAnalysis): string {
  const factSummaries = analysis.facts.map(f => 
    `- ${f.category}: ${f.oldValue ? `"${f.oldValue}" → "${f.newValue}"` : `"${f.newValue}"`} (${f.action}, confidence: ${f.confidence})`
  ).join("\n");

  return `Rewrite the compiled truth to incorporate the analyzed changes.

## Current Compiled Truth
${input.currentTruth || "(empty)"}

## Changes to Apply
${factSummaries}

## Source Attribution
Source: ${input.source}
Date: ${input.date}

## Change Type
${analysis.infoType}

## Task
Rewrite the compiled truth. Output ONLY JSON with this schema:
{
  "compiledTruth": "the full rewritten compiled truth content (markdown format)",
  "changed": true|false,
  "changeType": "update|replace|conflict|none",
  "changeSummary": "human-readable summary of what changed"
}

Rules:
1. For "replace" actions: remove the old value, add the new value
2. For "add" actions: append the new fact in appropriate section
3. Preserve the overall structure and style of existing content
4. Add source attribution: append " (Source: ${input.source}, ${input.date})" to updated facts
5. If structure doesn't exist, create appropriate sections (## Status, ## Facts, etc.)
6. "update" = modified existing content; "replace" = replaced entire section; "conflict" = contradictory info (keep both with notes)
7. Do NOT remove historical context - keep timeline references
8. Format as clean markdown

Example output for funding stage update:
{
  "compiledTruth": "## Status\n\n- **Funding Stage**: Series A (Source: meeting_notes, 2024-05-20)\n- **Valuation**: ~$50M (estimated)\n\n## History\n\n- Previously: Seed stage (until 2024-05-20)\n\n## Facts\n\n- ...",
  "changed": true,
  "changeType": "update",
  "changeSummary": "Updated funding stage from Seed to Series A"
}

/no_think`;
}

function buildTimelinePrompt(input: CompileInput, analysis: FactAnalysis): string {
  return `Extract timeline entries from this information.

## New Information
Date: ${input.date}
Source: ${input.source}
Content: ${input.newInfo}

## Analysis
Type: ${analysis.infoType}
Key Facts: ${analysis.facts.map(f => f.newValue).join(", ")}

## Task
Create timeline entries. Output ONLY JSON array:
[
  {
    "date": "YYYY-MM-DD",
    "source": "${input.source}",
    "summary": "one-line summary (max 80 chars)",
    "detail": "optional additional detail (markdown)"
  }
]

Rules:
1. Use the provided date, or extract exact date from content if mentioned
2. Summary should be concise and factual
3. Only create entries for significant events worth tracking
4. Max 2 entries per input
5. Empty array if nothing significant

/no_think`;
}

// ---------------------------------------------------------------------------
// LLM Call
// ---------------------------------------------------------------------------

// Use callLLM from llm-client module with custom system prompt
const COMPILER_SYSTEM_PROMPT = "You are a knowledge compilation assistant. You analyze information, extract facts, and maintain structured compiled truth. Always output valid JSON. Be precise and factual.";

// ---------------------------------------------------------------------------
// Response Parsing
// ---------------------------------------------------------------------------

function parseAnalysisResponse(resp: string): FactAnalysis {
  const match = resp.match(/\{[\s\S]*\}/);
  if (!match) {
    return { facts: [], infoType: "new_entity", entities: [], temporalContext: "" };
  }

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    
    const facts: ExtractedFact[] = [];
    const rawFacts = parsed.facts as unknown[] ?? [];
    for (const f of rawFacts) {
      if (typeof f !== "object" || f === null) continue;
      const fact = f as Record<string, unknown>;
      facts.push({
        category: String(fact.category ?? "other"),
        oldValue: fact.oldValue ? String(fact.oldValue) : undefined,
        newValue: String(fact.newValue ?? ""),
        action: fact.action === "replace" ? "replace" : "add",
        sourceSentence: String(fact.sourceSentence ?? ""),
        confidence: typeof fact.confidence === "number" ? fact.confidence : 0.8,
      });
    }

    return {
      facts,
      infoType: normalizeInfoType(String(parsed.infoType ?? "new_entity")),
      entities: (parsed.entities as unknown[] ?? []).map(String),
      temporalContext: String(parsed.temporalContext ?? ""),
    };
  } catch {
    return { facts: [], infoType: "new_entity", entities: [], temporalContext: "" };
  }
}

function parseMergeResponse(resp: string): { compiledTruth: string; changed: boolean; changeType: CompileResult["changeType"]; changeSummary: string } {
  const match = resp.match(/\{[\s\S]*\}/);
  if (!match) {
    return {
      compiledTruth: "",
      changed: false,
      changeType: "none",
      changeSummary: "Failed to parse LLM response",
    };
  }

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      compiledTruth: String(parsed.compiledTruth ?? ""),
      changed: Boolean(parsed.changed),
      changeType: normalizeChangeType(String(parsed.changeType ?? "none")),
      changeSummary: String(parsed.changeSummary ?? ""),
    };
  } catch {
    return {
      compiledTruth: "",
      changed: false,
      changeType: "none",
      changeSummary: "Failed to parse LLM response",
    };
  }
}

function parseTimelineResponse(resp: string, pageSlug: string): TimelineEntry[] {
  const match = resp.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[0]) as unknown[];
    const entries: TimelineEntry[] = [];
    
    for (const e of parsed) {
      if (typeof e !== "object" || e === null) continue;
      const entry = e as Record<string, unknown>;
      entries.push({
        pageSlug,
        date: String(entry.date ?? ""),
        source: String(entry.source ?? "manual"),
        summary: String(entry.summary ?? "").slice(0, 120),
        detail: String(entry.detail ?? ""),
      });
    }
    
    return entries;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeInfoType(raw: string): FactAnalysis["infoType"] {
  const valid = ["status_update", "new_event", "correction", "confirmation", "new_entity"] as const;
  const lower = raw.toLowerCase().trim();
  if (valid.includes(lower as typeof valid[number])) return lower as typeof valid[number];
  return "new_entity";
}

function normalizeChangeType(raw: string): CompileResult["changeType"] {
  const valid = ["append", "update", "replace", "none", "conflict"] as const;
  const lower = raw.toLowerCase().trim();
  if (valid.includes(lower as typeof valid[number])) return lower as typeof valid[number];
  return "none";
}

// resolveApiKey is now imported from llm-client module

function appendFact(current: string, newInfo: string, source: string): string {
  const timestamp = new Date().toISOString().slice(0, 10);
  const newLine = `- ${newInfo.trim()} (Source: ${source}, ${timestamp})`;
  
  if (!current.trim()) {
    return `## Facts\n\n${newLine}`;
  }
  
  if (!current.includes("## Facts")) {
    return `${current}\n\n## Facts\n\n${newLine}`;
  }
  
  return `${current}\n${newLine}`;
}

function appendStructuredFacts(current: string, facts: ExtractedFact[], source: string): string {
  const timestamp = new Date().toISOString().slice(0, 10);
  const newLines = facts.map(f => 
    `- **${f.category}**: ${f.newValue} (Source: ${source}, ${timestamp})`
  ).join("\n");
  
  if (!current.trim()) {
    return `## Facts\n\n${newLines}`;
  }
  
  if (!current.includes("## Facts")) {
    return `${current}\n\n## Facts\n\n${newLines}`;
  }
  
  return `${current}\n${newLines}`;
}