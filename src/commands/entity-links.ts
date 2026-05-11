import { BrainRepository } from "../repositories/brain-repo";
import { loadSettings } from "../settings";
import { extractRelations, entityToSlug } from "../ai/entity-link";
import { warning, subItem, createSpinner } from "../utils/cli-output";
import { formatDuration } from "../utils/progress";

/**
 * Extract entities and create entity pages + links.
 * Non-blocking: failures produce warnings, not errors.
 *
 * This is a **real seam** — called by both `put` (markdown + document branches)
 * and `import` (markdown + docx branches). Two adapters = real seam.
 */
export async function applyEntityLinks(
  repo: BrainRepository,
  sourceSlug: string,
  content: string,
  json: boolean,
): Promise<{ created: number; linked: number }> {
  if (!content.trim()) return { created: 0, linked: 0 };

  const settings = await loadSettings();
  if (!settings.llm.baseURL) {
    if (!json) {
      warning(`LLM not configured, skipping entity extraction for ${sourceSlug}`);
    }
    return { created: 0, linked: 0 };
  }

  const spinner = createSpinner();
  if (!json) {
    spinner.start(`Extracting entities from ${sourceSlug}...`);
  }

  const startTime = Date.now();
  let relations;
  try {
    relations = await extractRelations(content, settings.llm);
  } catch (err) {
    if (!json) {
      spinner.fail(`Entity extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { created: 0, linked: 0 };
  }

  // Filter by confidence
  const confidenceThreshold = settings.extraction.confidenceThreshold;
  const highConfidence = relations.filter((r) => r.confidence >= confidenceThreshold);
  const ignoredCount = relations.length - highConfidence.length;

  if (highConfidence.length === 0) {
    if (!json) {
      if (relations.length > 0) {
        spinner.warn(`Found ${relations.length} entities but all below confidence threshold (${confidenceThreshold})`);
      } else {
        spinner.warn(`No entities found in content`);
      }
    }
    return { created: 0, linked: 0 };
  }

  let created = 0;
  let linked = 0;

  for (const r of highConfidence) {
    // 1. Resolve entity slugs (disambiguation)
    const fromCandidate = entityToSlug(r.from.name, r.from.type);
    const toCandidate = entityToSlug(r.to.name, r.to.type);

    const fromSlug = await repo.findSimilarSlug(fromCandidate, r.from.name);
    const toSlug = await repo.findSimilarSlug(toCandidate, r.to.name);

    // 2. Ensure entity pages exist
    const c1 = await repo.ensureEntityPage(fromSlug, r.from.type, r.from.name, r.relation, r.context, sourceSlug);
    const c2 = await repo.ensureEntityPage(toSlug, r.to.type, r.to.name, r.relation, r.context, sourceSlug);
    if (c1) created += 1;
    if (c2) created += 1;

    // 3. Link between entities (context includes relation type)
    await repo.link(fromSlug, toSlug, `[${r.relation}] ${r.context}`);
    linked += 1;

    // 4. Link from source document to entities (for backlinks tracing)
    await repo.link(sourceSlug, fromSlug, `Mentions ${r.from.name}`);
    linked += 1;
    await repo.link(sourceSlug, toSlug, `Mentions ${r.to.name}`);
    linked += 1;
  }

  if (!json) {
    const duration = formatDuration(Date.now() - startTime);
    const entityNames = [...new Set(highConfidence.flatMap((r) => [r.from.name, r.to.name]))];
    spinner.succeed(`Extracted ${entityNames.length} entities: ${entityNames.join(", ")}`);

    // Print detailed info
    subItem(`${created} entity pages created`);
    subItem(`${linked} links added`);
    if (ignoredCount > 0) {
      subItem(`${ignoredCount} low-confidence relations ignored`);
    }
    subItem(`Completed in ${duration}`);
  }

  return { created, linked };
}
