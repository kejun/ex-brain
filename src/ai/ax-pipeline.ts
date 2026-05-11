/**
 * AIPipeline — Deep module encapsulating the full LLM call lifecycle.
 *
 * Encapsulates: createAxAI → guard → forward → parse → transform → fallback.
 * This eliminates boilerplate duplication across compiler.ts,
 * timeline-extractor.ts, and entity-link.ts.
 *
 * Each existing AI module becomes pure configuration (signature + mapping
 * functions) behind this deep interface.
 */

import { ax } from "@ax-llm/ax";
import type { Signature } from "@ax-llm/ax";
import type { ResolvedLLM } from "../settings";
import { createAxAI } from "./ax-adapter";

// ---------------------------------------------------------------------------
// Pipeline definition
// ---------------------------------------------------------------------------

export interface AIPipelineOptions<TInput, TRaw, TResult> {
  /** Ax Signature that defines input/output shape. */
  signature: Signature;
  /** Map domain input → Ax forward args. */
  mapInput: (input: TInput) => Record<string, unknown>;
  /** Extract the relevant field from raw Ax output before parsing. */
  extractOutput?: (raw: Record<string, unknown>) => unknown;
  /** Parse extracted output → structured intermediate. Return null on failure. */
  parseRaw: (raw: unknown) => TRaw | null;
  /** Transform parsed data + original input → final result. */
  transform: (raw: TRaw, input: TInput) => TResult;
  /** Fallback when LLM is unavailable or output is unparseable. */
  fallback: (input: TInput) => TResult;
  /** Log prefix for warnings (e.g. "Ax compilation"). */
  label: string;
}

export class AIPipeline<TInput, TRaw, TResult> {
  private gen: ReturnType<typeof ax>;

  constructor(private opts: AIPipelineOptions<TInput, TRaw, TResult>) {
    this.gen = ax(opts.signature);
  }

  /**
   * Execute the full LLM call lifecycle.
   * Returns fallback result if LLM is unavailable, forward fails,
   * or output cannot be parsed.
   */
  async run(input: TInput, llm: ResolvedLLM): Promise<TResult> {
    const ai = createAxAI(llm);
    if (!ai) return this.opts.fallback(input);

    try {
      const mapped = this.opts.mapInput(input);
      const result = await this.gen.forward(ai, mapped);
      const extracted = this.opts.extractOutput
        ? this.opts.extractOutput(result as Record<string, unknown>)
        : result;
      const raw = this.opts.parseRaw(extracted);
      if (!raw) return this.opts.fallback(input);
      return this.opts.transform(raw, input);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[ebrain] ${this.opts.label} failed, falling back: ${msg}`);
      return this.opts.fallback(input);
    }
  }
}

// ---------------------------------------------------------------------------
// JSON parsing utilities (shared across pipelines)
// ---------------------------------------------------------------------------

/** Parse unknown → object, handling string-encoded JSON. */
export function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "object" && raw !== null) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  }
  return null;
}

/** Parse unknown → array, handling string-encoded JSON. */
export function parseJsonArray<T = Record<string, unknown>>(raw: unknown): T[] | null {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as T[]; } catch { return null; }
  }
  return null;
}

/**
 * Normalize field names using alias mapping.
 * Accepts both English and Chinese LLM output variants.
 *
 * Example:
 *   normalizeFields(item, { fromName: ['fromName', 'from_name', 'from', '来源'] })
 */
export function normalizeFields(
  obj: Record<string, unknown>,
  aliases: Record<string, string[]>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [canonical, aliasList] of Object.entries(aliases)) {
    for (const alias of aliasList) {
      if (obj[alias] !== undefined) {
        result[canonical] = obj[alias];
        break;
      }
    }
  }
  return result;
}
