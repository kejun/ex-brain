// Test script for query --llm functionality
import { loadSettings } from "./src/settings";
import { BrainDb } from "./src/db/client";
import { BrainRepository } from "./src/repositories/brain-repo";

async function test() {
  const settings = await loadSettings();
  const db = await BrainDb.connect(settings.dbPath, settings);
  const repo = new BrainRepository(db);
  
  console.log("Testing query...");
  
  // Step 1: Query
  const hits = await repo.query("What is comprehension debt?", 3);
  console.log("Found hits:", hits.length);
  
  // Step 2: Get page contents
  const pages = await Promise.all(
    hits.slice(0, 2).map(async (hit) => {
      const page = await repo.getPage(hit.slug);
      return page ? { slug: hit.slug, title: page.title, content: page.compiledTruth.slice(0, 500) } : null;
    })
  );
  
  console.log("\nContext pages:");
  pages.filter(p => p).forEach(p => {
    console.log(`- ${p?.title} (${p?.slug})`);
  });
  
  // Step 3: Build prompt
  const context = pages
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map((p, i) => `## Source ${i + 1}: ${p.title}\n**Slug:** ${p.slug}\n\n${p.content}`)
    .join("\n\n---\n\n");
  
  console.log("\n--- Generated Context ---\n");
  console.log(context.slice(0, 1000) + "...");
  
  await db.close().catch(() => {});
}

test().catch(console.error);