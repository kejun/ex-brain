/**
 * Entity Link Extraction — AIPipeline version.
 *
 * Uses AIPipeline for LLM call lifecycle (createAxAI → forward → parse → transform → fallback).
 *
 * Public API unchanged — drop-in replacement for callers.
 */

import { f } from "@ax-llm/ax";
import type { ResolvedLLM } from "../settings";
import { entitySlugFromName } from "../slug-utils";
import { AIPipeline, normalizeFields } from "./ax-pipeline";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EntityType = "person" | "company" | "project" | "organization" | "event" | "other";

export type RelationType =
  | "founder_of" | "works_at" | "leader_of"
  | "collaborates_with" | "competes_with" | "acquired"
  | "part_of" | "invested_in" | "mentioned_in" | "related_to";

export interface EntityRef {
  name: string;
  type: EntityType;
}

export interface EntityRelation {
  type: "relation";
  from: EntityRef;
  to: EntityRef;
  relation: RelationType;
  context: string;
  confidence: number;
}

export type ExtractionResult = EntityRelation[];

// ---------------------------------------------------------------------------
// Entity pipeline configuration
// ---------------------------------------------------------------------------

const entitySig = f()
  .input("inputText", f.string("Text to extract entity relationships from"))
  .output("relations", f.json(
    "Extract only meaningful entity-to-entity relations. " +
    "An entity must be a standalone proper noun or named concept that can independently answer who/what it is. " +
    "Do NOT extract auxiliary verbs, action verbs, status words, generic nouns, grammatical fragments, or meaningless substring splits. " +
    "For Chinese text, do not split phrases into single-character fragments unless the character itself is a known standalone name. " +
    "Examples: in '需降级方案', do not extract '需'; in '模型未适配', do not extract '适配'; in '命名已定', do not extract '命名'. " +
    "Use other only for clear named concepts, product names, systems, standards, or domain terms that are not person/company/project/organization/event. " +
    "Use related_to sparingly; never use it to connect ordinary words. If uncertain, omit the relation. " +
    "Return Array of relations. Each: { fromName, fromType, toName, toType, relation, context (in Chinese), confidence }. " +
    "fromType/toType: person|company|project|organization|event|other. " +
    "relation: founder_of|works_at|leader_of|collaborates_with|competes_with|acquired|part_of|invested_in|mentioned_in|related_to. " +
    "confidence: 0-1."
  ))
  .build();

interface RawRelation {
  fromName?: string;
  fromType?: string;
  toName?: string;
  toType?: string;
  relation?: string;
  context?: string;
  confidence?: number;
}

function parseRelations(raw: unknown): RawRelation[] {
  if (Array.isArray(raw)) {
    return raw.map((item: Record<string, unknown>) => {
      const normalized = normalizeFields(item, {
        fromName: ['fromName', 'from_name', 'from', '来源'],
        fromType: ['fromType', 'from_type', '来源类型'],
        toName: ['toName', 'to_name', 'to', '目标'],
        toType: ['toType', 'to_type', '目标类型'],
        relation: ['relation', 'relationType', 'relation_type', '关系'],
        context: ['context', 'description', '描述', '上下文'],
      });
      return {
        fromName: String(normalized.fromName ?? ''),
        fromType: String(normalized.fromType ?? ''),
        toName: String(normalized.toName ?? ''),
        toType: String(normalized.toType ?? ''),
        relation: String(normalized.relation ?? ''),
        context: String(normalized.context ?? ''),
        confidence: typeof item.confidence === 'number' ? item.confidence :
                    typeof item.confidence === 'string' ? parseFloat(item.confidence) || 0.8 : 0.8,
      };
    }).filter(r => r.fromName && r.toName && r.relation);
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>[];
      return parseRelations(parsed);
    } catch { return []; }
  }
  return [];
}

const entityPipeline = new AIPipeline<
  { inputText: string },
  RawRelation[],
  RawRelation[]
>({
  signature: entitySig,
  mapInput: (input) => input,
  extractOutput: (raw) => raw.relations,
  parseRaw: parseRelations,
  transform: (raw) => raw,
  fallback: () => [],
  label: "Entity extraction",
});

// ---------------------------------------------------------------------------
// Entity slug helpers
// ---------------------------------------------------------------------------

export function entityToSlug(name: string, type: EntityType): string {
  return entitySlugFromName(name, type);
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function normalizeEntityType(raw: string): EntityType {
  if (!raw) return "other";
  const lower = raw.toLowerCase().trim();
  if (lower.includes("person") || lower.includes("people") || lower.includes("人物") || lower.includes("人")) return "person";
  if (lower.includes("company") || lower.includes("corp") || lower.includes("business") || lower.includes("公司") || lower.includes("企业")) return "company";
  if (lower.includes("project") || lower.includes("项目") || lower.includes("产品")) return "project";
  if (lower.includes("organization") || lower.includes("org") || lower.includes("ngo") || lower.includes("组织") || lower.includes("机构") || lower.includes("学校") || lower.includes("大学")) return "organization";
  if (lower.includes("event") || lower.includes("事件") || lower.includes("活动")) return "event";
  return "other";
}

function normalizeRelationType(raw: string): RelationType {
  if (!raw) return "related_to";
  const lower = raw.toLowerCase().trim().replace(/-/g, "_");
  const validTypes: RelationType[] = ["founder_of", "works_at", "leader_of", "collaborates_with", "competes_with", "acquired", "part_of", "invested_in", "mentioned_in", "related_to"];
  if (validTypes.includes(lower)) return lower;
  if (lower.includes("founder") || lower.includes("create") || lower.includes("创办") || lower.includes("创立")) return "founder_of";
  if (lower.includes("work") || lower.includes("join") || lower.includes("任职") || lower.includes("就职")) return "works_at";
  if (lower.includes("lead") || lower.includes("head") || lower.includes("manage") || lower.includes("负责")) return "leader_of";
  if (lower.includes("collabor") || lower.includes("partner") || lower.includes("合作")) return "collaborates_with";
  if (lower.includes("compet") || lower.includes("竞争")) return "competes_with";
  if (lower.includes("acquir") || lower.includes("buy") || lower.includes("收购")) return "acquired";
  if (lower.includes("invest") || lower.includes("投资")) return "invested_in";
  if (lower.includes("part") || lower.includes("belong") || lower.includes("隶属")) return "part_of";
  if (lower.includes("mention") || lower.includes("refer") || lower.includes("提及")) return "mentioned_in";
  return "related_to";
}

// ---------------------------------------------------------------------------
// Public API (unchanged)
// ---------------------------------------------------------------------------

export async function extractRelations(
  content: string,
  llm: ResolvedLLM,
  options?: {
    confidenceThreshold?: number;
  },
): Promise<ExtractionResult> {
  const trimmed = content.trim();
  if (!trimmed) return [];

  const context = trimmed.length <= 5000
    ? trimmed
    : trimmed.slice(0, 4000) + "\n\n...\n\n" + trimmed.slice(-1000);

  try {
    const rawRelations = await entityPipeline.run({ inputText: context }, llm);

    const threshold = options?.confidenceThreshold ?? 0.7;

    const relations: ExtractionResult = [];
    for (const r of rawRelations) {
      if (!r.fromName || !r.toName || !r.context) continue;
      relations.push({
        type: "relation",
        from: { name: r.fromName, type: normalizeEntityType(r.fromType) },
        to: { name: r.toName, type: normalizeEntityType(r.toType) },
        relation: normalizeRelationType(r.relation),
        context: String(r.context).trim(),
        confidence: typeof r.confidence === "number" ? r.confidence : 0.8,
      });
    }

    return relations.filter(r => r.confidence >= threshold);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[ebrain] Entity extraction failed: ${msg}`);
    return [];
  }
}
