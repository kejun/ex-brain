import { ResolvedLLM } from "../settings";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EntityType = "person" | "company" | "project" | "organization" | "event" | "other";

export type RelationType = 
  | "founder_of"
  | "works_at"
  | "leader_of"
  | "collaborates_with"
  | "competes_with"
  | "acquired"
  | "part_of"
  | "invested_in"
  | "mentioned_in"
  | "related_to";

export interface EntityRef {
  name: string;
  type: EntityType;
}

export interface EntityRelation {
  type: "relation";
  from: EntityRef;
  to: EntityRef;
  /** Semantic relation type. */
  relation: RelationType;
  /** The original sentence mentioning this relationship. */
  context: string;
  /** Confidence score 0.0 - 1.0. */
  confidence: number;
}

export type ExtractionResult = EntityRelation[];

// ---------------------------------------------------------------------------
// Entity type mapping for slug prefix
// ---------------------------------------------------------------------------

const TYPE_PREFIX: Record<EntityType, string> = {
  person: "people",
  company: "companies",
  project: "projects",
  organization: "organizations",
  event: "events",
  other: "entities",
};

/**
 * Convert an entity name to a slug: "Ali Partovi" → "ali-partovi"
 */
export function entityToSlug(name: string, type: EntityType): string {
  const prefix = TYPE_PREFIX[type] ?? "entities";
  const slugPart = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${prefix}/${slugPart || "untitled"}`;
}

// ---------------------------------------------------------------------------
// LLM extraction
// ---------------------------------------------------------------------------

const RELATION_TYPES = [
  "founder_of", "works_at", "leader_of", 
  "collaborates_with", "competes_with", "acquired", 
  "part_of", "invested_in", "mentioned_in", "related_to"
].join(", ");

/**
 * Use the configured LLM to extract entity relationships from text.
 * Returns a list of relations with relation type, confidence, and context.
 */
export async function extractRelations(
  content: string,
  llm: ResolvedLLM,
): Promise<ExtractionResult> {
  const trimmed = content.trim();
  if (!trimmed) return [];

  // Truncate for API efficiency: first 4000 + last 1000 chars
  let context: string;
  if (trimmed.length <= 5000) {
    context = trimmed;
  } else {
    context = trimmed.slice(0, 4000) + "\n\n...\n\n" + trimmed.slice(-1000);
  }

  const apiKey = resolveApiKey(llm);
  if (!apiKey) return [];

  const body = {
    model: llm.model,
    messages: [
      {
        role: "system",
        content:
          "You are a knowledge graph extraction assistant. " +
          "Identify relationships between named entities. " +
          "For each relationship, provide: from entity, to entity, relation type, confidence score, and exact context sentence. " +
          `Allowed relation types: ${RELATION_TYPES}. ` +
          "Output ONLY a JSON array. Schema: " +
          '{ "type": "relation", "from": {"name": "...", "type": "..."}, ' +
          '"to": {"name": "...", "type": "..."}, "relation": "...", "context": "...", "confidence": 0.9 }. ' +
          "Output ONLY the JSON array. /no_think",
      },
      {
        role: "user",
        content: `Extract relationships from:\n\n${context}`,
      },
    ],
    temperature: 0.1,
    max_tokens: 1024,
    enable_thinking: false,
  };

  try {
    const resp = await fetch(
      llm.baseURL.endsWith("/")
        ? llm.baseURL + "chat/completions"
        : llm.baseURL + "/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      },
    );

    if (!resp.ok) {
      const text = await resp.text();
      console.warn(
        `[ebrain] Entity extraction failed (${resp.status}): ${text.slice(0, 200)}`,
      );
      return [];
    }

    const data = await resp.json();
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) return [];

    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const parsed = JSON.parse(match[0]) as unknown[];
    const relations: ExtractionResult = [];

    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const r = item as Record<string, unknown>;
      if (r.type !== "relation") continue;

      const fromRef = parseEntityRef(r.from);
      const toRef = parseEntityRef(r.to);
      const relation = String(r.relation || "related_to");
      const contextStr = typeof r.context === "string" ? r.context.trim() : "";
      const confidence = typeof r.confidence === "number" ? r.confidence : 0.8;

      if (!fromRef || !toRef || !contextStr) continue;

      relations.push({
        type: "relation",
        from: fromRef,
        to: toRef,
        relation: normalizeRelationType(relation),
        context: contextStr,
        confidence,
      });
    }

    return relations;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[ebrain] Entity extraction error: ${msg}`);
    return [];
  }
}

function parseEntityRef(val: unknown): EntityRef | null {
  if (typeof val !== "object" || val === null) return null;
  const obj = val as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  const rawType = typeof obj.type === "string" ? obj.type : "other";
  if (!name) return null;
  return { name, type: normalizeEntityType(rawType) };
}

function normalizeEntityType(raw: string): EntityType {
  const lower = raw.toLowerCase().trim();
  if (lower.includes("person") || lower.includes("people")) return "person";
  if (lower.includes("company") || lower.includes("corp") || lower.includes("business")) return "company";
  if (lower.includes("project")) return "project";
  if (lower.includes("organization") || lower.includes("org") || lower.includes("ngo")) return "organization";
  if (lower.includes("event")) return "event";
  return "other";
}

export function normalizeRelationType(raw: string): RelationType {
  const lower = raw.toLowerCase().trim().replace(/-/g, "_");
  const validTypes = RELATION_TYPES.split(", ");
  if (validTypes.includes(lower as RelationType)) return lower as RelationType;
  // Fallbacks
  if (lower.includes("founder") || lower.includes("create")) return "founder_of";
  if (lower.includes("work") || lower.includes("join")) return "works_at";
  if (lower.includes("lead") || lower.includes("head") || lower.includes("manage")) return "leader_of";
  if (lower.includes("collabor") || lower.includes("partner")) return "collaborates_with";
  if (lower.includes("compet")) return "competes_with";
  if (lower.includes("acquir") || lower.includes("buy")) return "acquired";
  if (lower.includes("invest")) return "invested_in";
  if (lower.includes("part") || lower.includes("belong")) return "part_of";
  if (lower.includes("mention") || lower.includes("refer")) return "mentioned_in";
  return "related_to";
}

function resolveApiKey(llm: ResolvedLLM): string {
  if (llm.apiKey) return llm.apiKey;
  if (llm.apiKeyEnv) return process.env[llm.apiKeyEnv] ?? "";
  return "";
}
