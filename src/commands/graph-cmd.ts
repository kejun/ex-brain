import { Command } from "commander";
import { loadSettings } from "../settings";
import { BrainRepository } from "../repositories/brain-repo";
import { BrainDb } from "../db/client";
import { resolveApiKey } from "../ai/ax-adapter";

interface GraphNode {
  id: string;
  label: string;
  type: string;
  title: string;
  group: string;
}

/**
 * Normalize a type value.  Slug-like values (no `/` in the original slug,
 * contain `_`, or start with digits) are mapped to "article" so the filter
 * panel doesn't list every individual document as its own type.
 */
function normalizeType(rawType: string, slug: string): string {
  // If the raw type equals the slug's basename, it was inferred from a flat slug
  const baseName = slug.includes("/") ? slug.split("/").pop()! : slug;
  if (rawType === baseName || /^\d/.test(rawType) || rawType.startsWith("rm_")) {
    return "article";
  }
  return rawType;
}

interface GraphEdge {
  from: string;
  to: string;
  label: string;
  context: string;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    nodes: number;
    edges: number;
    types: Record<string, number>;
  };
}

async function getGraphData(repo: BrainRepository): Promise<GraphData> {
  // Get all pages as nodes
  const pages = await repo.listPages({ limit: 10000 });
  
  // Get all links as edges
  const linksRows = await repo.db.client.execute(
    `SELECT from_slug, to_slug, context FROM links ORDER BY from_slug ASC`
  );
  
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const typeCounts: Record<string, number> = {};
  
  // Create nodes from pages
  for (const page of pages) {
    const rawType = page.type || "other";
    const type = normalizeType(rawType, page.slug);
    typeCounts[type] = (typeCounts[type] || 0) + 1;
    
    nodes.push({
      id: page.slug,
      label: page.title || page.slug.split("/").pop() || page.slug,
      type,
      title: page.title,
      group: type,
    });
  }
  
  // Create edges from links
  for (const row of linksRows || []) {
    const r = row as { from_slug: string; to_slug: string; context: string };
    
    // Extract relation type from context
    const context = r.context || "";
    const labelMatch = context.match(/^\[([^\]]+)\]/);
    const label = labelMatch ? labelMatch[1] : "links";
    
    edges.push({
      from: r.from_slug,
      to: r.to_slug,
      label,
      context,
    });
  }
  
  return {
    nodes,
    edges,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      types: typeCounts,
    },
  };
}

async function getNodeDetails(repo: BrainRepository, slug: string) {
  const page = await repo.getPage(slug);
  if (!page) return null;
  
  const backlinks = await repo.backlinks(slug);
  const outgoingLinks = await repo.db.client.execute(
    `SELECT to_slug, context FROM links WHERE from_slug = ?`,
    [slug]
  );
  const timeline = await repo.timeline(slug, 10);
  
  return {
    page,
    backlinks,
    outgoingLinks: (outgoingLinks || []).map((r) => r as { to_slug: string; context: string }),
    timeline,
  };
}

export function registerGraphCommand(program: Command): void {
  program
    .command("graph")
    .option("-p, --port <port>", "web server port", "3000")
    .option("-h, --host <host>", "web server host", "localhost")
    .option("--no-open", "don't open browser automatically")
    .description("Start interactive knowledge graph visualization web server")
    .addHelpText(
      "after",
      `
Examples:
  ebrain graph                    # Start and open browser on http://localhost:3000
  ebrain graph --port 8080        # Start on http://localhost:8080
  ebrain graph --no-open          # Start without opening browser
`
    )
    .action(async (opts: { port: string; host: string; open?: boolean }) => {
      const settings = await loadSettings();
      const db = await BrainDb.connect(settings.dbPath, settings);
      const repo = new BrainRepository(db);
      
      const port = parseInt(opts.port, 10);
      const host = opts.host;
      
      console.log(`\n🌐 Starting Ex-Brain Server...`);
      console.log(`   Database: ${settings.dbPath}`);
      console.log(`   URL: http://${host}:${port}`);
      console.log(`\n   Press Ctrl+C to stop\n`);

      // Create the HTML page with embedded 3d-force-graph
      const htmlPage = getGraphHtml();
      
      // Start Bun server
      const server = Bun.serve({
        port,
        hostname: host,
        async fetch(req) {
          const url = new URL(req.url);
          
          // API endpoint: Get graph data
          if (url.pathname === "/api/graph") {
            try {
              const data = await getGraphData(repo);
              return Response.json(data);
            } catch (error) {
              return Response.json({ error: String(error) }, { status: 500 });
            }
          }
          
          // API endpoint: Get node details
          if (url.pathname.startsWith("/api/node/")) {
            const slug = decodeURIComponent(url.pathname.slice("/api/node/".length));
            try {
              const details = await getNodeDetails(repo, slug);
              if (!details) {
                return Response.json({ error: "Not found" }, { status: 404 });
              }
              return Response.json(details);
            } catch (error) {
              return Response.json({ error: String(error) }, { status: 500 });
            }
          }

          // API endpoint: Ask a question (SSE streaming)
          if (url.pathname === "/api/ask") {
            const question = url.searchParams.get("q") || "";
            if (!question) {
              return Response.json({ error: "Missing question" }, { status: 400 });
            }
            return handleAskQuestion(repo, question);
          }
          
          // Serve the HTML page
          if (url.pathname === "/" || url.pathname === "/index.html") {
            return new Response(htmlPage, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }
          
          // 404 for other paths
          return new Response("Not Found", { status: 404 });
        },
      });

      // Open browser automatically (default: true, use --no-open to disable)
      const shouldOpenBrowser = opts.open !== false;
      if (shouldOpenBrowser) {
        const openCommand = process.platform === "darwin" 
          ? "open" 
          : process.platform === "win32" 
            ? "start" 
            : "xdg-open";
        
        // Delay 500ms to ensure server is ready
        setTimeout(() => {
          try {
            Bun.spawn([openCommand, `http://${host}:${port}`], {
              detached: true,
            });
            console.log(`   Opening browser...\n`);
          } catch (e) {
            console.log(`   (Could not open browser: ${e})\n`);
          }
        }, 500);
      }
      
      // Keep the server running
      await new Promise(() => {}); // Never resolves
    });
}

// ---------------------------------------------------------------------------
// Q&A: Handle question with vector search + LLM streaming
// Uses the same context collection strategy as `ebrain query --llm`
// ---------------------------------------------------------------------------

interface ContextSection {
  type: 'primary' | 'raw_data' | 'linked';
  slug: string;
  title: string;
  content: string;
  label: string;
}

async function collectAskContext(
  repo: BrainRepository,
  hits: Array<{ slug: string; title: string; score: number }>,
  question: string,
  maxChars: number,
): Promise<{ sections: ContextSection[]; totalChars: number; stats: { primary: number; raw: number; linked: number } }> {
  const sections: ContextSection[] = [];
  let totalChars = 0;
  const stats = { primary: 0, raw: 0, linked: 0 };
  const seenSlugs = new Set<string>();

  function addSection(section: ContextSection): boolean {
    if (seenSlugs.has(`${section.type}:${section.slug}:${section.label}`)) return false;
    const budget = maxChars - totalChars;
    if (section.content.length > budget && sections.length > 0) {
      section.content = section.content.slice(0, budget - 20) + '\n...[truncated]';
    }
    if (section.content.length > 0) {
      sections.push(section);
      totalChars += section.content.length;
      seenSlugs.add(`${section.type}:${section.slug}:${section.label}`);
      return true;
    }
    return false;
  }

  const pageCache = new Map<string, { slug: string; title: string; compiledTruth?: string; timeline?: string }>();

  // Layer 1: Primary pages (compiledTruth + timeline)
  for (const hit of hits) {
    const page = await repo.getPage(hit.slug);
    if (!page) continue;
    pageCache.set(hit.slug, page);
    const parts: string[] = [];
    if (page.compiledTruth?.trim()) parts.push(page.compiledTruth.trim());
    if (page.timeline?.trim()) parts.push('## 时间线\n' + page.timeline.trim());
    if (parts.length > 0) {
      addSection({ type: 'primary', slug: page.slug, title: page.title, content: parts.join('\n\n'), label: '页面正文' });
      stats.primary++;
    }
  }

  // Layer 2: Raw data
  for (const hit of hits) {
    try {
      const rawRows = await repo.readRaw(hit.slug) as Array<{ source: string; data: unknown }>;
      for (const row of rawRows) {
        let rawContent = typeof row.data === 'string' ? row.data : JSON.stringify(row.data, null, 2);
        if (rawContent.trim()) {
          addSection({ type: 'raw_data', slug: hit.slug, title: hit.title, content: rawContent, label: `原始文档 (${row.source})` });
          stats.raw++;
        }
      }
    } catch { /* ignore */ }
  }

  // Layer 3: Linked pages
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

  // Score linked pages by keyword relevance
  const semanticScoreMap = new Map(hits.map(h => [h.slug, h.score]));
  const keywordScores = new Map<string, number>();
  const STOP_CHARS = new Set('的是了在和我有你就这不人都说上个大国为到以们年会生地要主中子自实家小对多能好可很所把当');
  const questionChars = [...question].filter(c => !/\s|[,.。!?、;:：""''()（）【】\[\]{}<>/\\|~`@#$%^&*+=_-]/.test(c) && !STOP_CHARS.has(c));
  const uniqueQuestionChars = new Set(questionChars);

  for (const linkedSlug of allLinkedSlugs) {
    if (semanticScoreMap.has(linkedSlug)) continue;
    const cached = pageCache.get(linkedSlug);
    if (cached) {
      const text = `${cached.title} ${cached.compiledTruth || ''}`.slice(0, 2000);
      let matched = 0;
      for (const char of uniqueQuestionChars) {
        if (text.toLowerCase().includes(char.toLowerCase())) matched++;
      }
      keywordScores.set(linkedSlug, uniqueQuestionChars.size > 0 ? matched / uniqueQuestionChars.size : 0);
    }
  }

  const scoredLinked = [...allLinkedSlugs].map(slug => ({
    slug, score: semanticScoreMap.get(slug) ?? keywordScores.get(slug) ?? 0,
  })).filter(s => s.score >= 0.02).sort((a, b) => b.score - a.score);

  for (const linked of scoredLinked) {
    if (totalChars >= maxChars) break;
    const linkedPage = pageCache.get(linked.slug) || await repo.getPage(linked.slug);
    if (!linkedPage || !linkedPage.compiledTruth?.trim()) continue;
    pageCache.set(linked.slug, linkedPage);
    const remaining = maxChars - totalChars;
    let content = linkedPage.compiledTruth.trim();
    if (content.length > remaining - 100) content = content.slice(0, remaining - 100) + '\n...[truncated]';
    addSection({
      type: 'linked', slug: linkedPage.slug, title: linkedPage.title,
      content, label: `关联页面: ${linkedPage.slug} (相关度: ${(linked.score * 100).toFixed(1)}%)`,
    });
    stats.linked++;
  }

  return { sections, totalChars, stats };
}

async function handleAskQuestion(repo: BrainRepository, question: string): Promise<Response> {
  const settings = await loadSettings();
  const llm = settings.llm;

  const apiKey = resolveApiKey(llm);
  if (!apiKey) {
    return new Response(
      `data: ${JSON.stringify({ type: 'error', message: 'LLM not configured. Please set DASHSCOPE_API_KEY or configure llm in settings.' })}\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } }
    );
  }

  // Step 1: Vector search (same as query --llm)
  const hits = await repo.query(question, 5);
  if (hits.length === 0) {
    return new Response(
      `data: ${JSON.stringify({ type: 'answer', content: '知识库中没有找到相关内容。', sources: [] })}\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } }
    );
  }

  // Step 2: Collect context (same 3-layer strategy as query --llm)
  const MAX_CONTEXT_CHARS = 100_000;
  const { sections, stats } = await collectAskContext(repo, hits, question, MAX_CONTEXT_CHARS);

  if (sections.length === 0) {
    return new Response(
      `data: ${JSON.stringify({ type: 'answer', content: '无法加载页面内容。', sources: [] })}\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } }
    );
  }

  // Build prompt (same format as query --llm)
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
  const prompt = `你是一个知识库助手，请根据提供的知识库内容回答问题。

## 问题
${question}

## 知识库内容

${context}

## 回答要求
- 仅基于提供的知识库内容回答，不要编造信息
- 如果知识库中没有相关信息，请明确说明
- 引用来源时使用 [[slug|标题]] 的格式
- 使用清晰的 markdown 格式
- 如果涉及时间线信息，请在回答中体现
- 区分哪些信息来自「页面正文」、哪些来自「原始文档」、哪些来自「关联页面」
- 语言与提问保持一致（中文提问用中文回答，英文提问用英文回答）

## 回答`;

  // Step 3: Stream LLM response (same params as query --llm)
  const encoder = new TextEncoder();
  const sources = sections.map(s => ({ slug: s.slug, title: s.title, type: s.type, label: s.label }));

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Send sources first
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ type: 'sources', sources })}\n\n`
        ));

        // Build URL
        const baseUrl = llm.baseURL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
        const url = baseUrl.endsWith('/') ? baseUrl + 'chat/completions' : baseUrl + '/chat/completions';

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: llm.model || 'qwen-plus',
            stream: true,
            messages: [
              {
                role: 'system',
                content: '你是一个专业的知识库助手，基于提供的知识库内容准确回答问题。引用来源时使用 [[slug|标题]] 格式。回答要条理清晰，区分信息来源。',
              },
              { role: 'user', content: prompt },
            ],
            temperature: 0.3,
            max_tokens: 4096,
            thinking: { type: 'disabled' },
          }),
          signal: AbortSignal.timeout(60_000),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ type: 'error', message: `LLM API error: ${response.status} ${errorText.replace(/[\n\r]/g, ' ')}` })}\n\n`
          ));
          controller.close();
          return;
        }

        const reader = response.body!.getReader();
        const textDecoder = new TextDecoder();
        let buffer = '';
        let totalChars = 0;
        let chunkCount = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunkCount++;

          // Use { stream: true } to handle multi-byte UTF-8 (Chinese chars)
          // that might be split across chunks
          buffer += textDecoder.decode(value, { stream: true });
          const lines = buffer.split(String.fromCharCode(10));
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Skip lines that don't start with 'data: '
            if (!trimmed.startsWith('data: ')) {
              // Check for [DONE] signal in non-data lines
              if (trimmed === '[DONE]') {
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ type: 'done' })}\n\n`
                ));
                controller.close();
                return;
              }
              continue;
            }

            try {
              const json = JSON.parse(trimmed.slice(6));

              // Check for [DONE] marker
              if (trimmed === 'data: [DONE]') {
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ type: 'done' })}\n\n`
                ));
                controller.close();
                return;
              }

              const delta = json.choices?.[0]?.delta;
              const content = delta?.content;
              const finishReason = json.choices?.[0]?.finish_reason;

              if (content) {
                totalChars += content.length;
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ type: 'delta', content })}\n\n`
                ));
              }

              // Check for finish_reason with a non-null value (stream ended)
              if (finishReason && finishReason !== 'null' && finishReason !== null) {
                console.log(`[ask] LLM finished with reason: ${finishReason}, total chars: ${totalChars}`);
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ type: 'done' })}\n\n`
                ));
                controller.close();
                return;
              }
            } catch (parseErr) {
              // Log but don't break the stream
              console.warn('[ask] SSE parse error:', String(parseErr), 'line:', trimmed.substring(0, 100));
            }
          }
        }

        console.log(`[ask] LLM stream ended. Chunks: ${chunkCount}, Total chars forwarded: ${totalChars}, Remaining buffer: ${buffer.length} chars`);

        // Process any remaining buffer content after stream ends
        if (buffer.trim()) {
          const trimmed = buffer.trim();
          if (trimmed === 'data: [DONE]' || trimmed === '[DONE]') {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: 'done' })}\n\n`
            ));
          } else if (trimmed.startsWith('data: ')) {
            try {
              const json = JSON.parse(trimmed.slice(6));
              const content = json.choices?.[0]?.delta?.content;
              if (content) {
                totalChars += content.length;
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ type: 'delta', content })}\n\n`
                ));
              }
            } catch { /* ignore */ }
          }
        }

        // Always send done at end of stream if we got any content
        if (totalChars > 0) {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ type: 'done' })}\n\n`
          ));
        }
        controller.close();
      } catch (error) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ type: 'error', message: String(error).replace(/[\n\r]/g, ' ') })}\n\n`
        ));
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

function getGraphHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ex-Brain Knowledge Graph</title>
  <script type="module">
    import ForceGraph3D from 'https://esm.sh/3d-force-graph@1.80.0';
    import SpriteText from 'https://esm.sh/three-spritetext@1.10.0';
    window.ForceGraph3D = ForceGraph3D;
    window.SpriteText = SpriteText;
    window.dispatchEvent(new Event('graph-deps-ready'));
  </script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    html, body {
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f0f0f;
      color: #e0e0e0;
      overflow: hidden;
    }
    
    #app {
      display: flex;
      height: 100vh;
    }
    
    #sidebar {
      width: 240px;
      background: #1a1a1a;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      position: fixed;
      z-index: 20;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
      transition: left 0.25s ease, top 0.25s ease, width 0.25s ease, height 0.25s ease, border-radius 0.25s ease;
    }
    
    /* Collapsed: Floating widget showing only header + search */
    #sidebar.collapsed {
      top: 60px;
      left: 20px;
      height: auto;
      max-height: calc(100vh - 70px);
      border: 1px solid #333;
      border-radius: 8px;
    }
    
    /* Expanded: Floating panel with 10px gap on top/left/bottom */
    #sidebar.expanded {
      top: 10px;
      left: 10px;
      bottom: 10px;
      height: auto;
      border: 1px solid #333;
      border-radius: 8px;
    }
    
    /* Hide content when collapsed */
    #sidebar.collapsed #search-box,
    #sidebar.collapsed #filters,
    #sidebar.collapsed #node-list {
      display: none;
    }
    
    /* Disable transition while dragging */
    #sidebar.dragging {
      transition: none;
    }
    
    #sidebar-header {
      padding: 16px;
      border-bottom: 1px solid #333;
      background: #222;
    }
    
    #sidebar-header h1 {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    
    #stats {
      font-size: 12px;
      color: #888;
    }
    
    #search-box {
      padding: 12px 16px;
      border-bottom: 1px solid #333;
    }
    
    #search-box input {
      width: 100%;
      padding: 8px 12px;
      border: 1px solid #333;
      border-radius: 6px;
      background: #252525;
      color: #e0e0e0;
      font-size: 13px;
    }
    
    #search-box input:focus {
      outline: none;
      border-color: #4a9eff;
    }
    
    #filters {
      padding: 12px 16px;
      border-bottom: 1px solid #333;
      font-size: 12px;
    }
    
    #filters label {
      display: inline-flex;
      align-items: center;
      margin-right: 12px;
      margin-bottom: 4px;
      cursor: pointer;
    }
    
    #filters input[type="checkbox"] {
      margin-right: 4px;
    }
    
    #node-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }
    
    .node-item {
      padding: 8px 12px;
      border-radius: 6px;
      cursor: pointer;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      word-break: break-all;
    }
    
    .node-item:hover {
      background: #2a2a2a;
    }
    
    .node-item.selected {
      background: #2a4a6a;
    }
    
    .node-type-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    
    #graph-container {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
    }
    
    #graph-3d {
      width: 100%;
      height: 100%;
      background: #000;
    }
    
    #graph-3d canvas {
      width: 100% !important;
      height: 100% !important;
      position: absolute;
    }
    
    #graph-3d > div {
      width: 100% !important;
      height: 100% !important;
    }
    
    #sidebar-toggle {
      padding: 8px;
      text-align: center;
      cursor: pointer;
      background: #222;
      border-top: 1px solid #333;
      color: #aaa;
      font-size: 12px;
      user-select: none;
      flex-shrink: 0;
    }
    #sidebar-toggle:hover {
      background: #2a2a2a;
      color: #fff;
    }
    
    #node-detail {
      position: absolute;
      width: 360px;
      min-width: 280px;
      max-width: calc(100vw - 320px);
      height: 480px;
      min-height: 200px;
      max-height: calc(100vh - 32px);
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 8px;
      overflow: hidden;
      display: none;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
    }
    
    #node-detail.visible {
      display: flex;
      flex-direction: column;
    }
    
    #detail-header {
      padding: 16px;
      border-bottom: 1px solid #333;
      background: #222;
      display: flex;
      justify-content: space-between;
      align-items: start;
      cursor: move;
      user-select: none;
      flex-shrink: 0;
    }
    
    #detail-header:hover {
      background: #282828;
    }
    
    #detail-header h2 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 4px;
    }
    
    #detail-header .type-badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 4px;
      background: #333;
    }
    
    #close-detail {
      background: none;
      border: none;
      color: #888;
      font-size: 20px;
      cursor: pointer;
      padding: 0;
      line-height: 1;
    }
    
    #close-detail:hover {
      color: #fff;
    }
    
    #detail-content {
      padding: 16px;
      overflow-y: auto;
      flex: 1;
      min-height: 0;
    }
    
    /* Custom resize handle — bottom-left corner */
    #resize-handle {
      position: absolute;
      left: 0;
      bottom: 0;
      width: 18px;
      height: 18px;
      cursor: nesw-resize;
      background: conic-gradient(from 135deg at 0% 100%, #aaa 0deg, #aaa 90deg, transparent 90deg);
      border-radius: 0 0 0 8px;
      z-index: 20;
      opacity: 0.6;
      transition: opacity 0.2s;
    }
    
    #resize-handle:hover {
      opacity: 1;
      background: conic-gradient(from 135deg at 0% 100%, #4a9eff 0deg, #4a9eff 90deg, transparent 90deg);
    }
    
    .detail-section {
      margin-bottom: 16px;
    }
    
    .detail-section h3 {
      font-size: 12px;
      color: #888;
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    
    .detail-section p {
      font-size: 13px;
      line-height: 1.6;
      white-space: pre-wrap;
    }
    
    .link-item {
      font-size: 13px;
      padding: 6px 0;
      border-bottom: 1px solid #252525;
    }
    
    .link-item:last-child {
      border-bottom: none;
    }
    
    .link-item a {
      color: #4a9eff;
      text-decoration: none;
    }
    
    .link-item a:hover {
      text-decoration: underline;
    }
    
    .timeline-item {
      padding: 8px 0;
      border-bottom: 1px solid #252525;
    }
    
    .timeline-date {
      font-size: 11px;
      color: #888;
      margin-bottom: 2px;
    }
    
    .timeline-summary {
      font-size: 13px;
    }
    .timeline-detail {
      font-size: 12px;
      color: #888;
      margin-top: 4px;
      padding-left: 8px;
      border-left: 2px solid #333;
    }
    
    #loading {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
    }
    
    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid #333;
      border-top-color: #4a9eff;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 16px;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    
    #toolbar {
      position: absolute;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 8px;
      background: #1a1a1a;
      padding: 8px;
      border-radius: 8px;
      border: 1px solid #333;
    }
    
    .toolbar-btn {
      padding: 8px 16px;
      background: #2a2a2a;
      border: 1px solid #333;
      border-radius: 6px;
      color: #e0e0e0;
      font-size: 13px;
      cursor: pointer;
    }
    
    .toolbar-btn:hover {
      background: #333;
    }
    
    /* Toggle Switch */
    .toolbar-switch {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 8px;
      cursor: pointer;
      user-select: none;
    }
    .switch-label {
      font-size: 13px;
      color: #e0e0e0;
    }
    .toolbar-switch input {
      display: none;
    }
    .slider {
      width: 36px;
      height: 20px;
      background: #333;
      border-radius: 10px;
      position: relative;
      transition: background 0.2s;
      border: 1px solid #555;
    }
    .slider::before {
      content: '';
      position: absolute;
      width: 14px;
      height: 14px;
      background: #e0e0e0;
      border-radius: 50%;
      top: 2px;
      left: 2px;
      transition: transform 0.2s;
    }
    .toolbar-switch input:checked + .slider {
      background: #4a9eff;
      border-color: #4a9eff;
    }
    .toolbar-switch input:checked + .slider::before {
      transform: translateX(16px);
    }
    
    /* Q&A Button - highlighted */
    #btn-ask {
      background: #4a9eff;
      border-color: #4a9eff;
      color: #fff;
    }
    #btn-ask:hover {
      background: #3a8eef;
    }
    
    /* Q&A Panel */
    #ask-panel {
      position: absolute;
      bottom: 70px;
      left: 50%;
      transform: translateX(-50%);
      width: 520px;
      max-width: calc(100vw - 40px);
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 12px;
      overflow: hidden;
      display: none;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }
    #ask-panel.visible {
      display: flex;
      flex-direction: column;
    }
    #ask-header {
      padding: 12px 16px;
      border-bottom: 1px solid #333;
      background: #222;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    #ask-header h2 {
      font-size: 14px;
      font-weight: 600;
      margin: 0;
    }
    #ask-close {
      background: none;
      border: none;
      color: #888;
      font-size: 18px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    #ask-close:hover {
      color: #fff;
    }
    #ask-input-row {
      display: flex;
      padding: 12px 16px;
      gap: 8px;
      border-bottom: 1px solid #333;
    }
    #ask-input {
      flex: 1;
      padding: 8px 12px;
      border: 1px solid #333;
      border-radius: 6px;
      background: #252525;
      color: #e0e0e0;
      font-size: 13px;
    }
    #ask-input:focus {
      outline: none;
      border-color: #4a9eff;
    }
    #ask-input:disabled {
      opacity: 0.5;
    }
    #ask-submit {
      padding: 8px 16px;
      background: #4a9eff;
      border: 1px solid #4a9eff;
      border-radius: 6px;
      color: #fff;
      font-size: 13px;
      cursor: pointer;
    }
    #ask-submit:hover {
      background: #3a8eef;
    }
    #ask-submit:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    #ask-result {
      padding: 16px;
      max-height: 400px;
      overflow-y: auto;
      font-size: 13px;
      line-height: 1.6;
    }
    #ask-result .sources {
      margin-bottom: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid #333;
    }
    #ask-result .sources h3 {
      font-size: 11px;
      color: #888;
      text-transform: uppercase;
      margin: 0 0 8px 0;
    }
    #ask-result .source-item {
      display: inline-block;
      padding: 2px 8px;
      margin: 0 4px 4px 0;
      background: #252525;
      border: 1px solid #333;
      border-radius: 4px;
      font-size: 12px;
      color: #4a9eff;
      cursor: pointer;
    }
    #ask-result .source-item:hover {
      background: #333;
    }
    #ask-result .answer {
      white-space: pre-wrap;
    }
    #ask-result .error {
      color: #f44336;
    }
    #ask-result .loading {
      color: #888;
      font-style: italic;
    }
    #ask-result .markdown-content {
      font-size: 13px;
      line-height: 1.6;
    }
    #ask-result .markdown-content code {
      background: #2a2a2a;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 12px;
    }
    #ask-result .markdown-content pre {
      background: #2a2a2a;
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 8px 0;
    }
    #ask-result .markdown-content pre code {
      background: none;
      padding: 0;
    }
    
    /* Type colors */
    .type-person { background: #4caf50; }
    .type-company { background: #2196f3; }
    .type-project { background: #ff9800; }
    .type-note { background: #9c27b0; }
    .type-deal { background: #f44336; }
    .type-yc { background: #ff5722; }
    .type-civic { background: #00bcd4; }
    .type-other { background: #607d8b; }
    
    /* Markdown content styles */
    .markdown-content {
      font-size: 13px;
      line-height: 1.6;
    }
    .markdown-content h1, .markdown-content h2, .markdown-content h3 {
      margin-top: 16px;
      margin-bottom: 8px;
      font-weight: 600;
    }
    .markdown-content h1 { font-size: 18px; }
    .markdown-content h2 { font-size: 16px; color: #aaa; }
    .markdown-content h3 { font-size: 14px; color: #888; }
    .markdown-content p { margin: 8px 0; }
    .markdown-content ul, .markdown-content ol {
      margin: 8px 0;
      padding-left: 20px;
    }
    .markdown-content li { margin: 4px 0; }
    .markdown-content code {
      background: #2a2a2a;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 12px;
    }
    .markdown-content pre {
      background: #2a2a2a;
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 8px 0;
    }
    .markdown-content pre code {
      background: none;
      padding: 0;
    }
    .markdown-content blockquote {
      border-left: 3px solid #444;
      margin: 8px 0;
      padding-left: 12px;
      color: #888;
    }
    .markdown-content a {
      color: #4a9eff;
      text-decoration: none;
    }
    .markdown-content a:hover {
      text-decoration: underline;
    }
    .markdown-content strong { color: #fff; }
    .markdown-content em { color: #ccc; }
    .markdown-content hr {
      border: none;
      border-top: 1px solid #333;
      margin: 16px 0;
    }
  </style>
</head>
<body>
  <div id="app">
    <div id="sidebar" class="collapsed">
      <div id="sidebar-header">
        <h1>Ex-Brain</h1>
        <div id="stats">Loading...</div>
      </div>
      <div id="search-box">
        <input type="text" id="search-input" placeholder="Search nodes...">
      </div>
      <div id="filters"></div>
      <div id="node-list"></div>
      <div id="sidebar-toggle">展开</div>
    </div>
    <div id="graph-container">
      <div id="loading">
        <div class="spinner"></div>
        <div>Loading graph...</div>
      </div>
      <div id="graph-3d"></div>
      <div id="node-detail">
        <div id="detail-header">
          <div>
            <h2 id="detail-title">-</h2>
            <span class="type-badge" id="detail-type">-</span>
          </div>
          <button id="close-detail">&times;</button>
        </div>
        <div id="detail-content"></div>
        <div id="resize-handle"></div>
      </div>
      <div id="toolbar">
        <button class="toolbar-btn" id="btn-fit">Fit View</button>
        <button class="toolbar-btn" id="btn-reset">Reset Filters</button>
        <label class="toolbar-switch">
          <span class="switch-label">Labels</span>
          <input type="checkbox" id="toggle-labels" checked>
          <span class="slider"></span>
        </label>
        <button class="toolbar-btn" id="btn-ask"> Ask</button>
      </div>
      <div id="ask-panel">
        <div id="ask-header">
          <h2>💡 Ask Ex-Brain</h2>
          <button id="ask-close">&times;</button>
        </div>
        <div id="ask-input-row">
          <input type="text" id="ask-input" placeholder="Ask a question about your knowledge base..." />
          <button id="ask-submit">Send</button>
        </div>
        <div id="ask-result"></div>
      </div>
    </div>
  </div>

  <script>
    
    // ── Config ──
    var labelsVisible = true;
    const typeColors = {
      person: '#4caf50', company: '#2196f3', project: '#ff9800',
      note: '#9c27b0', deal: '#f44336', yc: '#ff5722',
      civic: '#00bcd4', other: '#607d8b',
    };

    // ── Markdown parser ──
    function parseMarkdown(text) {
      if (!text) return '';
      try {
        if (typeof marked !== 'undefined') {
          if (typeof marked.parse === 'function') return marked.parse(text);
          if (typeof marked === 'function') return marked(text);
        }
      } catch (e) { console.warn('Markdown parse error:', e); }
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML
        .replace(/\\n/g, '<br>')
        .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\*([^*]+)\\*/g, '<em>$1</em>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^- (.+)$/gm, '<li>$1</li>');
    }

    // ── State ──
    let Graph = null;
    let graphData = null;
    let nodeMap = {};
    let selectedNode = null;
    let selectedNode3D = null;
    let activeTypes = new Set();
    let highlightNodes = new Set();
    let highlightLinks = new Set();
    let hoverNode = null;

    // Remap API edges → 3FG links
    function toLinks(edges) {
      return edges.map(function(e) {
        return { source: e.from, target: e.to, label: e.label, context: e.context };
      });
    }
    // ── Init ──
    async function init() {
      try {
        const res = await fetch('/api/graph');
        graphData = await res.json();

        // Index nodes
        nodeMap = {};
        graphData.nodes.forEach(function(n) { nodeMap[n.id] = n; });

        // Remap edges → links and cross-link neighbors
        var links = toLinks(graphData.edges);
        links.forEach(function(l) {
          var a = nodeMap[l.source], b = nodeMap[l.target];
          if (!a || !b) return;
          if (!a.neighbors) { a.neighbors = []; a.edgeList = []; }
          if (!b.neighbors) { b.neighbors = []; b.edgeList = []; }
          if (!a.neighbors.includes(b)) { a.neighbors.push(b); b.neighbors.push(a); }
          a.edgeList.push(l); b.edgeList.push(l);
        });
        graphData._links = links;

        updateStats();
        renderFilters();
        renderNodeList();
        create3DGraph();
        document.getElementById('loading').style.display = 'none';
      } catch (err) {
        document.getElementById('loading').innerHTML =
          '<div style="color:#f44336">Error: ' + escapeHtml(String(err)) + '</div>';
      }
    }

    function updateStats() {
      const s = graphData.stats;
      const t = Object.entries(s.types).map(function(p) { return p[0]+': '+p[1]; }).join(', ');
      document.getElementById('stats').textContent = s.nodes+' nodes, '+s.edges+' edges | '+t;
    }

    function renderFilters() {
      const types = Object.keys(graphData.stats.types);
      activeTypes = new Set(types);
      var container = document.getElementById('filters');
      container.innerHTML = types.map(function(t) {
        return '<label><input type="checkbox" checked data-type="'+t+'">'+
          '<span class="node-type-dot type-'+t+'"></span> '+t+'</label>';
      }).join('');
      container.querySelectorAll('input').forEach(function(inp) {
        inp.addEventListener('change', function() {
          inp.checked ? activeTypes.add(inp.dataset.type) : activeTypes.delete(inp.dataset.type);
          refreshGraph();
          renderNodeList();
        });
      });
    }

    function renderNodeList(filter) {
      filter = filter || '';
      var container = document.getElementById('node-list');
      var filtered = graphData.nodes
        .filter(function(n) { return activeTypes.has(n.type); })
        .filter(function(n) {
          return !filter || n.label.toLowerCase().indexOf(filter.toLowerCase()) >= 0 || n.id.toLowerCase().indexOf(filter.toLowerCase()) >= 0;
        })
        .slice(0, 200);
      container.innerHTML = filtered.map(function(node) {
        return '<div class="node-item'+(selectedNode===node.id?' selected':'')+'" data-slug="'+node.id+'">'+
          '<span class="node-type-dot type-'+node.type+'"></span>'+
          '<span>'+escapeHtml(node.label)+'</span></div>';
      }).join('');
      container.querySelectorAll('.node-item').forEach(function(item) {
        item.addEventListener('click', function() { selectNode(item.dataset.slug); });
      });
    }

    function computeDegrees() {
      var deg = {};
      graphData.edges.forEach(function(e) {
        deg[e.from] = (deg[e.from]||0)+1;
        deg[e.to]   = (deg[e.to]||0)+1;
      });
      return deg;
    }

    function refreshGraph() {
      if (!Graph) return;
      // Re-render without restarting the simulation
      Graph.refresh();
    }

    // ── 3D Graph ──
    function create3DGraph() {
      var degrees = computeDegrees();
      var maxDeg = Math.max(1);
      var keys = Object.keys(degrees);
      for (var i = 0; i < keys.length; i++) { if (degrees[keys[i]] > maxDeg) maxDeg = degrees[keys[i]]; }

      graphData.nodes.forEach(function(n) {
        n.val = 2 + 10 * ((degrees[n.id]||0) / maxDeg);
        n.color = typeColors[n.type] || typeColors.other;
      });

      var container = document.getElementById('graph-3d');
      Graph = new ForceGraph3D(container, { controlType: 'orbit' })
        .graphData({ nodes: graphData.nodes, links: graphData._links })
        .backgroundColor('#000000')
        .showNavInfo(false)
        .warmupTicks(300)
        .cooldownTicks(100)
        .cooldownTime(1500)
        .d3AlphaDecay(0.05)
        .d3VelocityDecay(0.6)
        .nodeVal('val')
        .nodeColor(function(n) {
          if (n === selectedNode3D) return '#ffffff';
          return highlightNodes.has(n) ? '#ffcc44' : n.color;
        })
        .nodeThreeObject(function(n) {
          if (!labelsVisible) return null;
          var text = (n.label || n.id || '').toString();
          if (!text) return null;
          try {
            var sprite = new SpriteText(text);
            sprite.material.depthWrite = false;
            sprite.color = n.color || '#fff';
            sprite.textHeight = n === selectedNode3D ? 12 : 8;
            sprite.center.y = -0.6;
            return sprite;
          } catch(e) {
            console.warn('SpriteText error for node', n.id, e);
            return null;
          }
        })
        .nodeThreeObjectExtend(true)
        .nodeLabel(function(n) { return n.label + '  (' + n.id + ')'; })
        .linkColor(function(l) { return '#777'; })
        .linkWidth(function(l) { return highlightLinks.has(l) ? 1.8 : 0.8; })
        .linkOpacity(0.3)
        .linkMaterial(null)
        .linkDirectionalArrowLength(0)
        .nodeVisibility(function(n) { return activeTypes.has(n.type); })
        .linkVisibility(function(l) {
          var st = (typeof l.source === 'object') ? l.source.type : (nodeMap[l.source]||{}).type;
          var tt = (typeof l.target === 'object') ? l.target.type : (nodeMap[l.target]||{}).type;
          return activeTypes.has(st) && activeTypes.has(tt);
        })
        .onNodeClick(function(node) {
          var now = Date.now(), last = window._fgLastClick || 0;
          window._fgLastClick = now;
          if (node && (now - last) < 350) { flyToNode(node); }
          else if (node) { selectedNode3D = node; selectNode(node.id); }
        })
        .onNodeHover(function(node) {
          if (selectedNode3D) return;
          if ((!node && !highlightNodes.size) || (node && hoverNode === node)) return;
          highlightNodes.clear(); highlightLinks.clear();
          if (node) {
            highlightNodes.add(node);
            if (node.neighbors) node.neighbors.forEach(function(nb) { highlightNodes.add(nb); });
            if (node.edgeList)  node.edgeList.forEach(function(lnk) { highlightLinks.add(lnk); });
          }
          hoverNode = node || null;
          refreshGraph();
        })
        .enableNavigationControls(true);

      // Optimize 3D layout: compact nodes with stronger attraction & weaker repulsion
      // Note: d3Force() returns the d3-force object, not the Graph instance, so we call them separately
      var linkForce = Graph.d3Force('link');
      if (linkForce) linkForce.distance(30).strength(0.8);
      var chargeForce = Graph.d3Force('charge');
      if (chargeForce) chargeForce.strength(-120);
      var centerForce = Graph.d3Force('center');
      if (centerForce) centerForce.strength(0.08);

      // Auto-rotate
      // Controls are created asynchronously by three-render-objects.
      // Wait a tick to ensure they are attached before configuring.
      setTimeout(function() {
        var controls = Graph.controls();
        if (!controls) return;
        controls.autoRotate = false;
        controls.zoomToCursor = true;
      }, 0);
      container.setAttribute('tabindex', '0');
      // Keyboard rotation via spherical coordinates — no THREE dependency needed.
      container.addEventListener('keydown', function(e) {
        var cam = Graph.camera();
        var ctrl = Graph.controls();
        if (!ctrl) return;
        var tgt = ctrl.target;
        var pos = cam.position;
        var angle = 0.05;

        // Convert offset to spherical coords
        var dx = pos.x - tgt.x, dy = pos.y - tgt.y, dz = pos.z - tgt.z;
        var r = Math.sqrt(dx*dx + dy*dy + dz*dz);
        var theta = Math.atan2(dx, dz); // horizontal
        var phi   = Math.acos(dy / r);   // vertical (0=+Y, π=-Y)

        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          theta += (e.key === 'ArrowLeft' ? -1 : 1) * angle;
          e.preventDefault();
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          phi += (e.key === 'ArrowUp' ? -1 : 1) * angle;
          phi = Math.max(0.01, Math.min(Math.PI - 0.01, phi));
          e.preventDefault();
        } else {
          return;
        }

        // Convert back to cartesian
        pos.x = tgt.x + r * Math.sin(phi) * Math.sin(theta);
        pos.y = tgt.y + r * Math.cos(phi);
        pos.z = tgt.z + r * Math.sin(phi) * Math.cos(theta);
        cam.lookAt(tgt);
        cam.updateMatrixWorld();
      });
      container.focus(); // Ensure container receives keyboard events

    }

    function flyToNode(node) {
      if (!Graph) return;
      Graph.cameraPosition({x:node.x,y:node.y,z:node.z+40},{x:node.x,y:node.y,z:node.z},1200);
    }

    // ── Node selection ──
    async function selectNode(slug) {
      selectedNode = slug;
      renderNodeList(document.getElementById('search-input').value);
      try {
        var res = await fetch('/api/node/' + encodeURIComponent(slug));
        showNodeDetail(await res.json());
      } catch (err) { console.error(err); }
    }

    function showNodeDetail(data) {
      var page = data.page, detail = document.getElementById('node-detail');
      var content = document.getElementById('detail-content');
      document.getElementById('detail-title').textContent = page.title;
      document.getElementById('detail-type').textContent = page.type;

      // Set 3D highlight: selected node + neighbors
      highlightNodes.clear(); highlightLinks.clear();
      var node = nodeMap[selectedNode];
      if (node && node.edgeList) {
        highlightNodes.add(node);
        node.neighbors.forEach(function(nb) { highlightNodes.add(nb); });
        node.edgeList.forEach(function(lnk) { highlightLinks.add(lnk); });
      }
      refreshGraph();

      var html = '';
      if (page.compiledTruth) {
        html += '<div class="detail-section"><h3>Compiled Truth</h3>'+
          '<div class="markdown-content">'+parseMarkdown(page.compiledTruth)+'</div></div>';
      }
      if (data.outgoingLinks && data.outgoingLinks.length > 0) {
        html += '<div class="detail-section"><h3>Links To ('+data.outgoingLinks.length+')</h3>'+
          data.outgoingLinks.map(function(l) {
            return '<div class="link-item"><a href="#" data-slug="'+l.to_slug+'">'+
              escapeHtml(l.to_slug)+'</a> <span style="color:#888">('+escapeHtml(l.context.slice(0,50))+')</span></div>';
          }).join('')+'</div>';
      }
      if (data.backlinks && data.backlinks.length > 0) {
        html += '<div class="detail-section"><h3>Referenced By ('+data.backlinks.length+')</h3>'+
          data.backlinks.map(function(slug) {
            return '<div class="link-item"><a href="#" data-slug="'+slug+'">'+
              escapeHtml(slug)+'</a></div>';
          }).join('')+'</div>';
      }
      if (data.timeline && data.timeline.length > 0) {
        html += '<div class="detail-section"><h3>Timeline</h3>'+
          data.timeline.map(function(t) {
            return '<div class="timeline-item"><div class="timeline-date">'+t.date+' | '+t.source+'</div>'+
              '<div class="timeline-summary">'+escapeHtml(t.summary)+'</div>'+
              (t.detail?'<div class="timeline-detail markdown-content">'+parseMarkdown(t.detail)+'</div>':'')+'</div>';
          }).join('')+'</div>';
      }
      content.innerHTML = html;
      content.querySelectorAll('a[data-slug]').forEach(function(a) {
        a.addEventListener('click', function(e) { e.preventDefault(); selectNode(a.dataset.slug); });
      });
      if (!detail.style.left) {
        var cr = document.getElementById('graph-container').getBoundingClientRect();
        detail.style.left = (cr.width - 376)+'px';
        detail.style.top = '16px';
      }
      detail.classList.add('visible');
    }

    function escapeHtml(text) {
      var div = document.createElement('div');
      div.textContent = text||''; return div.innerHTML;
    }

    // ── Event listeners ──
    document.getElementById('search-input').addEventListener('input', function(e) { renderNodeList(e.target.value); });
    document.getElementById('close-detail').addEventListener('click', function() {
      document.getElementById('node-detail').classList.remove('visible');
      selectedNode = null; selectedNode3D = null;
      highlightNodes.clear(); highlightLinks.clear();
      refreshGraph();
      renderNodeList(document.getElementById('search-input').value);
    });
    document.getElementById('btn-fit').addEventListener('click', function() {
      if (Graph) Graph.zoomToFit(600, 60, function(n) { return activeTypes.has(n.type); });
    });

    // Toggle labels visibility via switch
    document.getElementById('toggle-labels').addEventListener('change', function() {
      labelsVisible = this.checked;
      Graph.nodeThreeObject(function(n) {
        if (!labelsVisible) return null;
        var text = (n.label || n.id || '').toString();
        if (!text) return null;
        try {
          var sprite = new SpriteText(text);
          sprite.material.depthWrite = false;
          sprite.color = n.color || '#fff';
          sprite.textHeight = n === selectedNode3D ? 12 : 8;
          sprite.center.y = -0.6;
          return sprite;
        } catch(e) {
          return null;
        }
      });
      Graph.refresh();
    });

    document.getElementById('btn-reset').addEventListener('click', function() {
      document.querySelectorAll('#filters input').forEach(function(inp) {
        inp.checked = true; activeTypes.add(inp.dataset.type);
      });
      refreshGraph(); renderNodeList();
    });

    // ── Q&A Panel ──
    var askPanel = document.getElementById('ask-panel');
    var askInput = document.getElementById('ask-input');
    var askResult = document.getElementById('ask-result');
    var askSubmit = document.getElementById('ask-submit');
    var askClose = document.getElementById('ask-close');
    var askBtn = document.getElementById('btn-ask');
    var isStreaming = false;

    askBtn.addEventListener('click', function() {
      askPanel.classList.toggle('visible');
      if (askPanel.classList.contains('visible')) {
        setTimeout(function() { askInput.focus(); }, 100);
      }
    });
    askClose.addEventListener('click', function() {
      askPanel.classList.remove('visible');
      if (isStreaming) {
        // Stop streaming if in progress
        window._askAbort && window._askAbort.abort();
      }
    });

    function askQuestion() {
      var question = askInput.value.trim();
      if (!question || isStreaming) return;

      isStreaming = true;
      askSubmit.disabled = true;
      askInput.disabled = true;
      askResult.innerHTML = '<div class="loading">Searching knowledge base...</div>';

      window._askAbort = new AbortController();

      fetch('/api/ask?q=' + encodeURIComponent(question), {
        signal: window._askAbort.signal
      }).then(function(response) {
        if (!response.ok) {
          throw new Error('Request failed with status ' + response.status);
        }

        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        var answer = '';
        var sources = [];

        function read() {
          return reader.read().then(function(result) {
            if (result.done) {
              // Stream ended - finalize with whatever we have
              try {
                if (answer.length > 0) {
                  var finalHtml = '<div class="sources"><h3>Sources (' + sources.length + ')</h3>' +
                    sources.map(function(s) {
                      return '<span class="source-item" data-slug="' + escapeHtml(s.slug) + '">' + escapeHtml(s.title) + '</span>';
                    }).join('') + '</div>' +
                    '<div class="answer markdown-content">' + parseMarkdown(answer) + '</div>';
                  askResult.innerHTML = finalHtml;
                  bindSourceClicks();
                } else if (sources.length === 0) {
                  askResult.innerHTML = '<div class="error">No response received.</div>';
                }
              } catch (finalizeErr) {
                console.error('Finalize error:', finalizeErr);
                askResult.innerHTML = '<div class="answer markdown-content">' + escapeHtml(answer) + '</div>';
              }
              isStreaming = false;
              askSubmit.disabled = false;
              askInput.disabled = false;
              askInput.focus();
              return;
            }

            buffer += decoder.decode(result.value, { stream: true });
            var lines = buffer.split(String.fromCharCode(10));
            buffer = lines.pop() || '';

            for (var i = 0; i < lines.length; i++) {
              var line = lines[i].trim();
              if (!line) continue;
              if (!line.startsWith('data: ')) continue;

              try {
                var data = JSON.parse(line.slice(6));
                if (data.type === 'sources') {
                  sources = data.sources || [];
                  askResult.innerHTML = '<div class="sources"><h3>Sources (' + sources.length + ')</h3>' +
                    sources.map(function(s) {
                      return '<span class="source-item" data-slug="' + escapeHtml(s.slug) + '">' + escapeHtml(s.title) + '</span>';
                    }).join('') + '</div>' +
                    '<div class="answer markdown-content">Loading answer...</div>';
                  bindSourceClicks();
                } else if (data.type === 'delta') {
                  answer += data.content;
                  var answerEl = askResult.querySelector('.answer');
                  if (answerEl) answerEl.textContent = answer;
                } else if (data.type === 'done') {
                  // Finalize - wrap in try-catch to prevent parseMarkdown errors from breaking finalization
                  try {
                    if (answer.length > 0) {
                      var finalHtml = '<div class="sources"><h3>Sources (' + sources.length + ')</h3>' +
                        sources.map(function(s) {
                          return '<span class="source-item" data-slug="' + escapeHtml(s.slug) + '">' + escapeHtml(s.title) + '</span>';
                        }).join('') + '</div>' +
                        '<div class="answer markdown-content">' + parseMarkdown(answer) + '</div>';
                      askResult.innerHTML = finalHtml;
                      bindSourceClicks();
                    }
                  } catch (finalizeErr) {
                    console.error('Finalize error:', finalizeErr);
                    // Fallback: show raw text if markdown parsing fails
                    var answerEl = askResult.querySelector('.answer');
                    if (answerEl) answerEl.textContent = answer;
                  }
                  isStreaming = false;
                  askSubmit.disabled = false;
                  askInput.disabled = false;
                  askInput.focus();
                } else if (data.type === 'error') {
                  askResult.innerHTML = '<div class="error">Error: ' + escapeHtml(data.message) + '</div>';
                  isStreaming = false;
                  askSubmit.disabled = false;
                  askInput.disabled = false;
                }
              } catch (e) {
                // Skip malformed SSE lines, don't break the stream
              }
            }

            return read();
          }).catch(function(err) {
            // Handle stream read errors
            if (err.name === 'AbortError') return;
            console.error('Stream read error:', err);
            if (answer.length > 0) {
              var finalHtml = '<div class="sources"><h3>Sources (' + sources.length + ')</h3>' +
                sources.map(function(s) {
                  return '<span class="source-item" data-slug="' + escapeHtml(s.slug) + '">' + escapeHtml(s.title) + '</span>';
                }).join('') + '</div>' +
                '<div class="answer markdown-content">' + parseMarkdown(answer) + '</div>';
              askResult.innerHTML = finalHtml;
              bindSourceClicks();
            } else {
              askResult.innerHTML = '<div class="error">Connection error: ' + escapeHtml(String(err)) + '</div>';
            }
            isStreaming = false;
            askSubmit.disabled = false;
            askInput.disabled = false;
          });
        }

        return read();
      }).catch(function(err) {
        if (err.name === 'AbortError') return;
        askResult.innerHTML = '<div class="error">Error: ' + escapeHtml(String(err)) + '</div>';
        isStreaming = false;
        askSubmit.disabled = false;
        askInput.disabled = false;
      });
    }

    function buildResultHtml(answer, sources, question) {
      var html = '';
      if (sources.length > 0) {
        html += '<div class="sources"><h3>Sources (' + sources.length + ')</h3>';
        html += sources.map(function(s) {
          return '<span class="source-item" data-slug="' + escapeHtml(s.slug) + '">' + escapeHtml(s.title) + '</span>';
        }).join('');
        html += '</div>';
      }
      html += '<div class="answer markdown-content">' + parseMarkdown(answer) + '</div>';
      return html;
    }

    function bindSourceClicks() {
      askResult.querySelectorAll('.source-item').forEach(function(item) {
        item.addEventListener('click', function() {
          selectNode(item.dataset.slug);
        });
      });
    }

    askSubmit.addEventListener('click', askQuestion);
    askInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        askQuestion();
      }
    });

    // Drag / resize
    var nodeDetail = document.getElementById('node-detail');
    var detailHeader = document.getElementById('detail-header');
    var resizeHandle = document.getElementById('resize-handle');
    var isDragging = false, isResizing = false;
    var dragStartX, dragStartY, elemStartX, elemStartY;
    var resizeStartX, resizeStartY, startWidth, startHeight;

    detailHeader.addEventListener('mousedown', function(e) {
      if (e.target.id === 'close-detail') return;
      isDragging = true;
      dragStartX = e.clientX; dragStartY = e.clientY;
      elemStartX = parseInt(nodeDetail.style.left)||nodeDetail.getBoundingClientRect().left;
      elemStartY = parseInt(nodeDetail.style.top)||nodeDetail.getBoundingClientRect().top;
      e.preventDefault();
    });
    resizeHandle.addEventListener('mousedown', function(e) {
      isResizing = true;
      resizeStartX = e.clientX; resizeStartY = e.clientY;
      startWidth = nodeDetail.offsetWidth; startHeight = nodeDetail.offsetHeight;
      elemStartX = parseInt(nodeDetail.style.left)||nodeDetail.getBoundingClientRect().left;
      elemStartY = parseInt(nodeDetail.style.top)||nodeDetail.getBoundingClientRect().top;
      e.preventDefault(); e.stopPropagation();
    });
    document.addEventListener('mousemove', function(e) {
      if (isDragging) {
        nodeDetail.style.left = Math.max(0,Math.min(window.innerWidth-nodeDetail.offsetWidth,elemStartX+e.clientX-dragStartX))+'px';
        nodeDetail.style.top  = Math.max(0,Math.min(window.innerHeight-nodeDetail.offsetHeight,elemStartY+e.clientY-dragStartY))+'px';
      }
      if (isResizing) {
        var dx = e.clientX - resizeStartX;
        var dy = e.clientY - resizeStartY;
        var newWidth  = Math.max(280, Math.min(window.innerWidth - 320, startWidth - dx));
        var newHeight = Math.max(200, Math.min(window.innerHeight - 32, startHeight + dy));
        nodeDetail.style.left   = Math.max(0, elemStartX + dx)+'px';
        nodeDetail.style.width  = newWidth+'px';
        nodeDetail.style.height = newHeight+'px';
      }
    });
    document.addEventListener('mouseup', function() { isDragging = false; isResizing = false; });

    // ── Sidebar Float & Toggle ──
    var sidebar = document.getElementById('sidebar');
    var sidebarHeader = document.getElementById('sidebar-header');
    var sidebarToggle = document.getElementById('sidebar-toggle');
    var isSidebarDrag = false;
    var sbDragX, sbDragY, sbStartX, sbStartY;

    // Toggle
    sidebarToggle.addEventListener('click', function() {
      if (sidebar.classList.contains('collapsed')) {
        sidebar.classList.remove('collapsed');
        sidebar.classList.add('expanded');
        sidebar.style.top = '';
        sidebar.style.left = '';
        sidebarToggle.textContent = '收起';
      } else {
        sidebar.classList.remove('expanded');
        sidebar.classList.add('collapsed');
        sidebarToggle.textContent = '展开';
      }
    });

    // Drag (only when collapsed)
    sidebarHeader.addEventListener('mousedown', function(e) {
      if (sidebar.classList.contains('expanded')) return;
      isSidebarDrag = true;
      sidebar.classList.add('dragging');
      sbDragX = e.clientX;
      sbDragY = e.clientY;
      sbStartX = parseInt(sidebar.style.left) || sidebar.getBoundingClientRect().left;
      sbStartY = parseInt(sidebar.style.top) || sidebar.getBoundingClientRect().top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', function(e) {
      if (!isSidebarDrag) return;
      sidebar.style.left = (sbStartX + e.clientX - sbDragX) + 'px';
      sidebar.style.top  = (sbStartY + e.clientY - sbDragY) + 'px';
    });

    document.addEventListener('mouseup', function() {
      if (isSidebarDrag) {
        isSidebarDrag = false;
        sidebar.classList.remove('dragging');
      }
    });

    // Wait for ES module dependencies to load
    window.addEventListener('graph-deps-ready', function() { init(); });
  </script>
</body>
</html>`;
}