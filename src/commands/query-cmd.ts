import { Command } from "commander";
import { BrainRepository } from "../repositories/brain-repo";
import { loadSettings, type ResolvedLLM } from "../settings";
import { withRepo, isJson, print } from "./shared";
import { createProgress, formatDuration } from "../utils/progress";

// ---------------------------------------------------------------------------
// Context collection for LLM answers
// ---------------------------------------------------------------------------

interface ContextSection {
  type: 'primary' | 'raw_data' | 'linked';
  slug: string;
  title: string;
  content: string;
  label: string;
}

interface ContextStats {
  primaryPages: number;
  rawDocs: number;
  linkedPages: number;
  skippedChars: number;
}

async function collectContextForLLM(
  repo: BrainRepository,
  hits: Array<{ slug: string; title: string; score: number }>,
  question: string,
  maxChars: number,
  onProgress?: (stage: string) => void,
): Promise<{ sections: ContextSection[]; totalChars: number; stats: ContextStats }> {
  const sections: ContextSection[] = [];
  let totalChars = 0;
  const stats: ContextStats = {
    primaryPages: 0,
    rawDocs: 0,
    linkedPages: 0,
    skippedChars: 0,
  };

  const seenSlugs = new Set<string>();

  function addSection(section: ContextSection): boolean {
    if (seenSlugs.has(`${section.type}:${section.slug}:${section.label}`)) {
      return false;
    }
    const budget = maxChars - totalChars;
    if (section.content.length > budget && sections.length > 0) {
      section.content = section.content.slice(0, budget - 20) + '\n...[truncated]';
      stats.skippedChars += section.content.length - budget;
    }
    if (section.content.length > 0) {
      sections.push(section);
      totalChars += section.content.length;
      seenSlugs.add(`${section.type}:${section.slug}:${section.label}`);
      return true;
    }
    return false;
  }

  const pageCache = new Map<string, NonNullable<Awaited<ReturnType<typeof repo.getPage>>>>();

  // Layer 1: Primary pages
  onProgress?.('page content');
  for (const hit of hits) {
    const page = await repo.getPage(hit.slug);
    if (!page) continue;
    pageCache.set(hit.slug, page);

    const parts: string[] = [];
    if (page.compiledTruth?.trim()) {
      parts.push(page.compiledTruth.trim());
    }
    const tl = page.timeline?.trim();
    if (tl) {
      parts.push(`## 时间线\n${tl}`);
    }

    if (parts.length > 0) {
      addSection({
        type: 'primary',
        slug: page.slug,
        title: page.title,
        content: parts.join('\n\n'),
        label: `页面正文`,
      });
      stats.primaryPages++;
    }
  }

  // Layer 2: Raw data
  onProgress?.('raw documents');
  for (const hit of hits) {
    try {
      const rawRows = await repo.readRaw(hit.slug) as Array<{ source: string; data: unknown; fetchedAt?: string }>;
      for (const row of rawRows) {
        let rawContent = '';
        if (typeof row.data === 'string') {
          rawContent = row.data;
        } else if (typeof row.data === 'object' && row.data !== null) {
          rawContent = JSON.stringify(row.data, null, 2);
        }
        if (rawContent.trim()) {
          addSection({
            type: 'raw_data',
            slug: hit.slug,
            title: hit.title,
            content: rawContent,
            label: `原始文档 (${row.source})`,
          });
          stats.rawDocs++;
        }
      }
    } catch { /* non-fatal */ }
  }

  // Layer 3: Linked pages
  onProgress?.('linked pages');
  const allLinkedSlugs = new Set<string>();
  for (const hit of hits) {
    try {
      const outLinks = await repo.outgoingLinks(hit.slug);
      outLinks.forEach(l => allLinkedSlugs.add(l.slug));
    } catch { /* ignore */ }
    try {
      const backlinkSlugs = await repo.backlinks(hit.slug);
      backlinkSlugs.forEach(s => allLinkedSlugs.add(s));
    } catch { /* ignore */ }
  }

  if (allLinkedSlugs.size > 0) {
    const semanticScoreMap = new Map(hits.map(h => [h.slug, h.score]));
    const keywordScores = new Map<string, number>();
    for (const linkedSlug of allLinkedSlugs) {
      if (semanticScoreMap.has(linkedSlug)) continue;
      const cached = pageCache.get(linkedSlug);
      if (cached) {
        const text = `${cached.title} ${cached.compiledTruth}`.slice(0, 2000);
        keywordScores.set(linkedSlug, computeKeywordRelevance(text, question));
      } else {
        const page = await repo.getPage(linkedSlug);
        if (page) {
          pageCache.set(linkedSlug, page);
          const text = `${page.title} ${page.compiledTruth}`.slice(0, 2000);
          keywordScores.set(linkedSlug, computeKeywordRelevance(text, question));
        }
      }
    }

    const scoredLinked = [...allLinkedSlugs].map(slug => ({
      slug,
      score: semanticScoreMap.get(slug) ?? keywordScores.get(slug) ?? 0,
    }));

    const MIN_LINKED_SCORE = 0.02;
    const relevantLinked = scoredLinked
      .filter(s => s.score >= MIN_LINKED_SCORE)
      .sort((a, b) => b.score - a.score);

    for (const linked of relevantLinked) {
      if (totalChars >= maxChars) break;

      const linkedPage = pageCache.get(linked.slug);
      if (!linkedPage || !linkedPage.compiledTruth?.trim()) continue;

      const remaining = maxChars - totalChars;
      let content = linkedPage.compiledTruth.trim();
      if (content.length > remaining - 100) {
        content = content.slice(0, remaining - 100) + '\n...[truncated]';
      }

      addSection({
        type: 'linked',
        slug: linkedPage.slug,
        title: linkedPage.title,
        content,
        label: `关联页面: ${linkedPage.slug} (相关度: ${(linked.score * 100).toFixed(1)}%)`,
      });
      stats.linkedPages++;

      if (linked.score > 0.1) {
        try {
          const rawRows = await repo.readRaw(linked.slug) as Array<{ source: string; data: unknown }>;
          for (const row of rawRows) {
            let rawContent = typeof row.data === 'string' ? row.data : JSON.stringify(row.data);
            if (rawContent.trim().length > 100) {
              const remaining2 = maxChars - totalChars;
              if (rawContent.length > remaining2 - 100) {
                rawContent = rawContent.slice(0, remaining2 - 100) + '\n...[truncated]';
              }
              addSection({
                type: 'raw_data',
                slug: linked.slug,
                title: linkedPage.title,
                content: rawContent,
                label: `原始文档 (关联: ${row.source})`,
              });
              stats.rawDocs++;
            }
          }
        } catch { /* ignore */ }
      }
    }
  }

  return { sections, totalChars, stats };
}

function computeKeywordRelevance(text: string, question: string): number {
  const STOP_CHARS = new Set('的是了在和我有你就这不人都说上个大国为到以们年会生地要主中子自实家小对多能好可很所把当');
  const questionChars = [...question]
    .filter(c => !/\s|[,,。!?、;::""''()()【】\[\]{}<>\/\\|~`@#$%^&*+=_-]/.test(c) && !STOP_CHARS.has(c));
  if (questionChars.length === 0) return 0;

  const uniqueChars = new Set(questionChars);
  const lower = text.toLowerCase();
  let matched = 0;
  for (const char of uniqueChars) {
    if (lower.includes(char.toLowerCase())) matched++;
  }
  return matched / uniqueChars.size;
}

async function generateAnswerWithStream(
  question: string,
  sections: ContextSection[],
  stats: ContextStats,
  llm: ResolvedLLM,
): Promise<{ answer: string; ok: boolean }> {
  const apiKey = llm.apiKey || process.env[llm.apiKeyEnv] || "";
  if (!apiKey) {
    return { answer: "Error: LLM API key not configured.", ok: false };
  }

  if (sections.length === 0) {
    return { answer: "知识库中没有找到相关内容。", ok: true };
  }

  const contextParts: string[] = [];
  let sectionIndex = 0;

  const primarySections = sections.filter(s => s.type === 'primary');
  const rawSections = sections.filter(s => s.type === 'raw_data');
  const linkedSections = sections.filter(s => s.type === 'linked');

  function renderSections(group: ContextSection[], header: string) {
    if (group.length === 0) return;
    contextParts.push(`## ${header}\n`);
    for (const s of group) {
      sectionIndex++;
      contextParts.push(`### [${sectionIndex}] ${s.title} - ${s.label}\n**Slug:** ${s.slug}\n\n${s.content}\n`);
    }
    contextParts.push('');
  }

  renderSections(primarySections, '页面正文');
  renderSections(rawSections, '原始文档');
  renderSections(linkedSections, '关联页面');

  const context = contextParts.join('\n');

  const prompt = `你是一个知识库助手,请根据提供的知识库内容回答问题。

## 问题
${question}

## 知识库内容

${context}

## 回答要求
- 仅基于提供的知识库内容回答,不要编造信息
- 如果知识库中没有相关信息,请明确说明
- 引用来源时使用 [[slug|标题]] 的格式
- 使用清晰的 markdown 格式
- 如果涉及时间线信息,请在回答中体现
- 区分哪些信息来自「页面正文」、哪些来自「原始文档」、哪些来自「关联页面」
- 语言与提问保持一致(中文提问用中文回答,英文提问用英文回答)

## 回答`;

  const disableThinking: Record<string, unknown> = {
    thinking: { type: "disabled" },
  };
  const extraBody: Record<string, unknown> = {
    thinking: { type: "disabled" },
  };

  try {
    const url = llm.baseURL.endsWith("/") ? llm.baseURL + "chat/completions" : llm.baseURL + "/chat/completions";

    process.stderr.write(`\x1b[35m💭\x1b[0m \x1b[2mConnecting to ${llm.model}...\x1b[0m\n`);

    const resp = await fetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: llm.model,
          stream: true,
          messages: [
            {
              role: "system",
              content: "你是一个专业的知识库助手,基于提供的知识库内容准确回答问题。引用来源时使用 [[slug|标题]] 格式。回答要条理清晰,区分信息来源。",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 4096,
          ...disableThinking,
          extra_body: extraBody,
          thinking: { type: "disabled" },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!resp.ok) {
      const text = await resp.text();
      process.stderr.write("\r\x1b[K");
      return { answer: `Error: LLM API failed (${resp.status}): ${text.slice(0, 200)}`, ok: false };
    }

    if (!resp.body) {
      process.stderr.write("\r\x1b[K");
      return { answer: "Error: No response body from LLM API.", ok: false };
    }

    process.stderr.write("\r\x1b[K");
    process.stderr.write(`\x1b[32m✦\x1b[0m \x1b[2mStreaming response...\x1b[0m\n`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let fullAnswer = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;

        try {
          const json = JSON.parse(trimmed.slice(6));
          const content = json.choices?.[0]?.delta?.content;
          if (content) {
            process.stdout.write(content);
            fullAnswer += content;
          }
        } catch { /* skip malformed SSE */ }
      }
    }

    process.stdout.write("\n");

    return { answer: fullAnswer || "(No answer generated)", ok: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { answer: `Error: ${msg}`, ok: false };
  }
}

// ---------------------------------------------------------------------------
// Query command
// ---------------------------------------------------------------------------

export function registerQueryCommand(program: Command): void {
  program
    .command("query")
    .argument("<question>", "natural language question")
    .option("--limit <number>", "max results", "10")
    .option("--llm", "use LLM to answer based on retrieved context", false)
    .option("--context-limit <number>", "max pages to use as context", "5")
    .description("semantic / vector search")
    .addHelpText(
      "after",
      `
Examples:
  ebrain query "What projects did we ship in Q4?"
  ebrain query "Who leads the ML team?" --limit 5
  ebrain query "What are the key findings?" --llm
`,
    )
    .action(async (question: string, opts: Record<string, string>) => {
      await withRepo(program, async (repo) => {
        const limit = Number(opts.limit ?? 10);
        const hits = await repo.query(question, limit);

        if (opts.llm) {
          const settings = await loadSettings();
          if (!settings.llm.baseURL) {
            print(program, { error: "LLM not configured. Set llm.baseURL in settings." });
            return;
          }

          const progress = createProgress();
          progress.start("Searching knowledge base...");

          const contextLimit = Number(opts.contextLimit ?? 5);
          const topHits = hits.slice(0, contextLimit);

          if (topHits.length === 0) {
            progress.stop();
            process.stderr.write("No relevant pages found.\n");
            print(program, { answer: "No relevant information found in the knowledge base.", sources: [] });
            return;
          }

          const MAX_CONTEXT_CHARS = 100_000;
          const ctxStart = Date.now();
          progress.update(`Loading page content...`);
          const { sections, totalChars, stats } = await collectContextForLLM(repo, topHits, question, MAX_CONTEXT_CHARS, (stage) => {
            progress.update(`Loading ${stage}...`);
          });
          const ctxDuration = formatDuration(Date.now() - ctxStart);

          if (sections.length === 0) {
            progress.stop();
            process.stderr.write("No content could be loaded.\n");
            print(program, { answer: "Failed to load page content.", sources: [] });
            return;
          }

          progress.succeed(`Loaded ${stats.primaryPages} page(s), ${stats.rawDocs} raw doc(s), ${stats.linkedPages} linked page(s) (${ctxDuration})`);
          const startTime = Date.now();

          const { answer, ok } = await generateAnswerWithStream(question, sections, stats, settings.llm);

          if (!ok) {
            console.log(answer);
            return;
          }

          const duration = formatDuration(Date.now() - startTime);

          console.log("\n---\n**Sources:**\n");
          for (let i = 0; i < sections.length; i++) {
            const s = sections[i];
            const icon = s.type === 'primary' ? '📄' : s.type === 'raw_data' ? '📎' : '🔗';
            console.log(`${icon} ${i + 1}. [[${s.slug}|${s.title}]] - ${s.label} (${(s.content.length / 1024).toFixed(1)}KB)`);
          }
          console.log(`\n*Context: ${stats.primaryPages} page(s), ${stats.rawDocs} raw doc(s), ${stats.linkedPages} linked page(s)*`);
        } else {
          print(program, hits);
        }
      });
    });

  // -- search ---------------------------------------------------------------
  program
    .command("search")
    .argument("<query>", "full-text search query")
    .option("--type <type>", "filter by page type")
    .option("--limit <number>", "max results", "10")
    .description("full-text / hybrid search")
    .addHelpText(
      "after",
      `
Examples:
  ebrain search "machine learning"
  ebrain search "quarterly revenue" --type deal --limit 5
`,
    )
    .action(async (query: string, opts: Record<string, string>) => {
      await withRepo(program, async (repo) => {
        const hits = await repo.search(
          query,
          Number(opts.limit ?? 10),
          opts.type,
        );
        print(program, hits);
      });
    });
}
