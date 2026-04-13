/**
 * Entity Link Extraction — Ax Signature version.
 *
 * Uses f.json() for complex output instead of f.object().array()
 * because Ax's tool calling response parsing has compatibility issues
 * with DashScope/qwen models.
 */

import { ax, f } from "@ax-llm/ax";
import type { ResolvedLLM } from "../settings";
import { createAxAI } from "./ax-adapter";

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
// Signature definition (using json type for complex output)
// ---------------------------------------------------------------------------

const entitySig = f()
  .input("inputText", f.string("Text to extract entity relationships from"))
  .output("relations", f.json(
    "Array of relations. Each: { fromName, fromType, toName, toType, relation, context (in Chinese), confidence }. " +
    "fromType/toType: person|company|project|organization|event|other. " +
    "relation: founder_of|works_at|leader_of|collaborates_with|competes_with|acquired|part_of|invested_in|mentioned_in|related_to. " +
    "confidence: 0-1."
  ))
  .build();

const entityGen = ax(entitySig);

// ---------------------------------------------------------------------------
// Entity slug helpers
// ---------------------------------------------------------------------------

const TYPE_PREFIX: Record<EntityType, string> = {
  person: "people",
  company: "companies",
  project: "projects",
  organization: "organizations",
  event: "events",
  other: "entities",
};

export function entityToSlug(name: string, type: EntityType): string {
  const prefix = TYPE_PREFIX[type] ?? "entities";
  const slugPart = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${prefix}/${slugPart || "untitled"}`;
}

// ---------------------------------------------------------------------------
// Public API
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

  const aiClient = createAxAI(llm);
  if (!aiClient) return [];

  const context = trimmed.length <= 5000
    ? trimmed
    : trimmed.slice(0, 4000) + "\n\n...\n\n" + trimmed.slice(-1000);

  try {
    const result = await entityGen.forward(aiClient, { inputText: context });

    const rawRelations = parseRelations(result.relations);
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
    // Handle both English and Chinese field names from LLM output
    return raw.map((item: Record<string, unknown>) => {
      // Normalize field names: accept both English and Chinese variants
      return {
        fromName: String(item.fromName ?? item.from_name ?? item.from ?? item.来源 ?? ''),
        fromType: String(item.fromType ?? item.from_type ?? item.fromType ?? item.来源类型 ?? ''),
        toName: String(item.toName ?? item.to_name ?? item.to ?? item.目标 ?? ''),
        toType: String(item.toType ?? item.to_type ?? item.toType ?? item.目标类型 ?? ''),
        relation: String(item.relation ?? item.relationType ?? item.relation_type ?? item.关系 ?? ''),
        context: String(item.context ?? item.description ?? item.描述 ?? item.上下文 ?? ''),
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

export function normalizeRelationType(raw: string): RelationType {
  if (!raw) return "related_to";
  const lower = raw.toLowerCase().trim().replace(/-/g, "_");
  const validTypes = ["founder_of", "works_at", "leader_of", "collaborates_with", "competes_with", "acquired", "part_of", "invested_in", "mentioned_in", "related_to"];
  if (validTypes.includes(lower)) return lower as RelationType;
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
