import { Command } from "commander";
import { loadSettings } from "../settings";
import { BrainRepository } from "../repositories/brain-repo";
import { BrainDb } from "../db/client";

interface GraphNode {
  id: string;
  label: string;
  type: string;
  title: string;
  group: string;
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
    const type = page.type || "other";
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

      // Create the HTML page with embedded vis.js
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

function getGraphHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ex-Brain Knowledge Graph</title>
  <script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
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
      width: 320px;
      background: #1a1a1a;
      border-right: 1px solid #333;
      display: flex;
      flex-direction: column;
      overflow: hidden;
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
      flex: 1;
      position: relative;
    }
    
    #network {
      width: 100%;
      height: 100%;
    }
    
    #node-detail {
      position: absolute;
      width: 360px;
      min-width: 280px;
      max-width: calc(100vw - 400px);
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
    
    /* Custom resize handle */
    #resize-handle {
      position: absolute;
      right: 0;
      bottom: 0;
      width: 16px;
      height: 16px;
      cursor: nwse-resize;
      background: linear-gradient(135deg, transparent 50%, #555 50%);
      border-radius: 0 0 8px 0;
      opacity: 0.5;
      transition: opacity 0.2s;
    }
    
    #resize-handle:hover {
      opacity: 1;
      background: linear-gradient(135deg, transparent 50%, #4a9eff 50%);
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
    <div id="sidebar">
      <div id="sidebar-header">
        <h1>Ex-Brain</h1>
        <div id="stats">Loading...</div>
      </div>
      <div id="search-box">
        <input type="text" id="search-input" placeholder="Search nodes...">
      </div>
      <div id="filters"></div>
      <div id="node-list"></div>
    </div>
    <div id="graph-container">
      <div id="loading">
        <div class="spinner"></div>
        <div>Loading graph...</div>
      </div>
      <div id="network"></div>
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
    </div>
      <div id="toolbar">
        <button class="toolbar-btn" id="btn-fit">Fit View</button>
        <button class="toolbar-btn" id="btn-reset">Reset Filters</button>
        <button class="toolbar-btn" id="btn-physics">Toggle Physics</button>
      </div>
    </div>
  </div>

  <script>
    // Type colors mapping
    const typeColors = {
      person: '#4caf50',
      company: '#2196f3',
      project: '#ff9800',
      note: '#9c27b0',
      deal: '#f44336',
      yc: '#ff5722',
      civic: '#00bcd4',
      other: '#607d8b',
    };

    // Safe markdown parser with fallback
    function parseMarkdown(text) {
      if (!text) return '';
      try {
        // marked.js v4+ uses marked.parse(), older versions use marked() directly
        if (typeof marked !== 'undefined') {
          if (typeof marked.parse === 'function') {
            return marked.parse(text);
          } else if (typeof marked === 'function') {
            return marked(text);
          }
        }
      } catch (e) {
        console.warn('Markdown parse error:', e);
      }
      // Fallback: simple text formatting
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

    let network = null;
    let graphData = null;
    let nodes = null;
    let edges = null;
    let selectedNode = null;
    let physicsEnabled = true;
    let activeTypes = new Set();

    // Initialize
    async function init() {
      try {
        const response = await fetch('/api/graph');
        graphData = await response.json();
        
        updateStats();
        renderFilters();
        renderNodeList();
        createNetwork();
        
        document.getElementById('loading').style.display = 'none';
      } catch (error) {
        document.getElementById('loading').innerHTML = 
          '<div style="color: #f44336;">Error loading graph: ' + error + '</div>';
      }
    }

    function updateStats() {
      const stats = graphData.stats;
      const typeList = Object.entries(stats.types)
        .map(([type, count]) => type + ': ' + count)
        .join(', ');
      document.getElementById('stats').textContent = 
        stats.nodes + ' nodes, ' + stats.edges + ' edges | ' + typeList;
    }

    function renderFilters() {
      const container = document.getElementById('filters');
      const types = Object.keys(graphData.stats.types);
      
      activeTypes = new Set(types);
      
      container.innerHTML = types.map(type => 
        '<label><input type="checkbox" checked data-type="' + type + '">' +
        '<span class="node-type-dot type-' + type + '"></span> ' + type + '</label>'
      ).join('');
      
      container.querySelectorAll('input').forEach(input => {
        input.addEventListener('change', () => {
          if (input.checked) {
            activeTypes.add(input.dataset.type);
          } else {
            activeTypes.delete(input.dataset.type);
          }
          updateNetworkVisibility();
          renderNodeList();
        });
      });
    }

    function renderNodeList(filter = '') {
      const container = document.getElementById('node-list');
      const filtered = graphData.nodes
        .filter(n => activeTypes.has(n.type))
        .filter(n => !filter || 
          n.label.toLowerCase().includes(filter.toLowerCase()) ||
          n.id.toLowerCase().includes(filter.toLowerCase()))
        .slice(0, 200);
      
      container.innerHTML = filtered.map(node => 
        '<div class="node-item' + (selectedNode === node.id ? ' selected' : '') + '" data-slug="' + node.id + '">' +
        '<span class="node-type-dot type-' + node.type + '"></span>' +
        '<span>' + escapeHtml(node.label) + '</span>' +
        '</div>'
      ).join('');
      
      container.querySelectorAll('.node-item').forEach(item => {
        item.addEventListener('click', () => {
          selectNode(item.dataset.slug);
        });
      });
    }

    function createNetwork() {
      nodes = new vis.DataSet(graphData.nodes.map(n => ({
        id: n.id,
        label: n.label,
        group: n.type,
        title: n.title + '\\n(' + n.id + ')',
        color: typeColors[n.type] || typeColors.other,
        font: { color: '#e0e0e0', size: 12 },
        borderWidth: 1,
        borderWidthSelected: 3,
      })));
      
      edges = new vis.DataSet(graphData.edges.map(e => ({
        from: e.from,
        to: e.to,
        label: e.label,
        title: e.context,
        arrows: 'to',
        color: { color: '#444', highlight: '#4a9eff' },
        font: { color: '#666', size: 10, strokeWidth: 0 },
        smooth: { type: 'continuous' },
      })));
      
      const container = document.getElementById('network');
      const data = { nodes, edges };
      const options = {
        nodes: {
          shape: 'dot',
          size: 16,
          font: { strokeWidth: 0 },
        },
        edges: {
          width: 0.5,
          smooth: { type: 'continuous' },
        },
        physics: {
          enabled: true,
          solver: 'forceAtlas2Based',
          forceAtlas2Based: {
            gravitationalConstant: -50,
            springLength: 100,
            springConstant: 0.08,
          },
          stabilization: { iterations: 100 },
        },
        interaction: {
          hover: true,
          tooltipDelay: 200,
          navigationButtons: true,
          keyboard: true,
        },
        groups: Object.fromEntries(
          Object.entries(typeColors).map(([type, color]) => [type, { color }])
        ),
      };
      
      network = new vis.Network(container, data, options);
      
      network.on('click', params => {
        if (params.nodes.length > 0) {
          selectNode(params.nodes[0]);
        }
      });
      
      network.on('doubleClick', params => {
        if (params.nodes.length > 0) {
          focusNode(params.nodes[0]);
        }
      });
      
      // Fit view after stabilization
      network.once('stabilizationIterationsDone', () => {
        network.fit({ animation: true });
      });
    }

    function updateNetworkVisibility() {
      if (!nodes) return;
      
      graphData.nodes.forEach(node => {
        const visible = activeTypes.has(node.type);
        nodes.update({ id: node.id, hidden: !visible });
      });
      
      // Also hide edges connected to hidden nodes
      graphData.edges.forEach(edge => {
        const fromNode = graphData.nodes.find(n => n.id === edge.from);
        const toNode = graphData.nodes.find(n => n.id === edge.to);
        const visible = fromNode && toNode && 
          activeTypes.has(fromNode.type) && activeTypes.has(toNode.type);
        edges.update({ id: edge.from + '->' + edge.to, hidden: !visible });
      });
    }

    async function selectNode(slug) {
      selectedNode = slug;
      renderNodeList(document.getElementById('search-input').value);
      
      // Highlight in network
      if (network) {
        network.selectNodes([slug]);
        network.focus(slug, { animation: true, scale: 1 });
      }
      
      // Fetch details
      try {
        const response = await fetch('/api/node/' + encodeURIComponent(slug));
        const data = await response.json();
        showNodeDetail(data);
      } catch (error) {
        console.error('Error fetching node details:', error);
      }
    }

    function focusNode(slug) {
      if (!network) return;
      
      // Get connected nodes
      const connectedNodes = new Set([slug]);
      graphData.edges.forEach(e => {
        if (e.from === slug) connectedNodes.add(e.to);
        if (e.to === slug) connectedNodes.add(e.from);
      });
      
      // Focus on subgraph
      network.fit({
        nodes: Array.from(connectedNodes),
        animation: true,
      });
    }

    function showNodeDetail(data) {
      const page = data.page;
      const detail = document.getElementById('node-detail');
      const content = document.getElementById('detail-content');
      
      document.getElementById('detail-title').textContent = page.title;
      document.getElementById('detail-type').textContent = page.type;
      
      let html = '';
      
      // Compiled truth - render as markdown
      if (page.compiledTruth) {
        const renderedMd = parseMarkdown(page.compiledTruth);
        html += '<div class="detail-section">' +
          '<h3>Compiled Truth</h3>' +
          '<div class="markdown-content">' + renderedMd + '</div>' +
          '</div>';
      }
      
      // Outgoing links
      if (data.outgoingLinks && data.outgoingLinks.length > 0) {
        html += '<div class="detail-section">' +
          '<h3>Links To (' + data.outgoingLinks.length + ')</h3>' +
          data.outgoingLinks.map(l => 
            '<div class="link-item"><a href="#" data-slug="' + l.to_slug + '">' + 
            escapeHtml(l.to_slug) + '</a> <span style="color:#888">(' + 
            escapeHtml(l.context.slice(0, 50)) + ')</span></div>'
          ).join('') +
          '</div>';
      }
      
      // Backlinks
      if (data.backlinks && data.backlinks.length > 0) {
        html += '<div class="detail-section">' +
          '<h3>Referenced By (' + data.backlinks.length + ')</h3>' +
          data.backlinks.map(slug => 
            '<div class="link-item"><a href="#" data-slug="' + slug + '">' + 
            escapeHtml(slug) + '</a></div>'
          ).join('') +
          '</div>';
      }
      
      // Timeline
      if (data.timeline && data.timeline.length > 0) {
        html += '<div class="detail-section">' +
          '<h3>Timeline</h3>' +
          data.timeline.map(t => 
            '<div class="timeline-item">' +
            '<div class="timeline-date">' + t.date + ' | ' + t.source + '</div>' +
            '<div class="timeline-summary">' + escapeHtml(t.summary) + '</div>' +
            (t.detail ? '<div class="timeline-detail markdown-content">' + parseMarkdown(t.detail) + '</div>' : '') +
            '</div>'
          ).join('') +
          '</div>';
      }
      
      content.innerHTML = html;
      
      // Add click handlers for links
      content.querySelectorAll('a[data-slug]').forEach(a => {
        a.addEventListener('click', e => {
          e.preventDefault();
          selectNode(a.dataset.slug);
        });
      });
      
      // Initialize position if not already set
      if (!detail.style.left) {
        const container = document.getElementById('graph-container');
        const containerRect = container.getBoundingClientRect();
        detail.style.left = (containerRect.width - 376) + 'px';
        detail.style.top = '16px';
      }
      
      detail.classList.add('visible');
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text || '';
      return div.innerHTML;
    }

    // Event listeners
    document.getElementById('search-input').addEventListener('input', e => {
      renderNodeList(e.target.value);
    });

    document.getElementById('close-detail').addEventListener('click', () => {
      document.getElementById('node-detail').classList.remove('visible');
      selectedNode = null;
      if (network) network.unselectAll();
      renderNodeList(document.getElementById('search-input').value);
    });

    document.getElementById('btn-fit').addEventListener('click', () => {
      if (network) network.fit({ animation: true });
    });

    document.getElementById('btn-reset').addEventListener('click', () => {
      document.querySelectorAll('#filters input').forEach(input => {
        input.checked = true;
        activeTypes.add(input.dataset.type);
      });
      updateNetworkVisibility();
      renderNodeList();
    });

    document.getElementById('btn-physics').addEventListener('click', () => {
      physicsEnabled = !physicsEnabled;
      if (network) {
        network.setOptions({ physics: { enabled: physicsEnabled } });
      }
    });

    // Drag to move node-detail panel
    const nodeDetail = document.getElementById('node-detail');
    const detailHeader = document.getElementById('detail-header');
    const resizeHandle = document.getElementById('resize-handle');
    let isDragging = false;
    let isResizing = false;
    let dragStartX, dragStartY, elemStartX, elemStartY;
    let resizeStartX, resizeStartY, startWidth, startHeight;

    detailHeader.addEventListener('mousedown', (e) => {
      // Don't drag when clicking close button
      if (e.target.id === 'close-detail') return;
      
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      elemStartX = parseInt(nodeDetail.style.left) || nodeDetail.getBoundingClientRect().left;
      elemStartY = parseInt(nodeDetail.style.top) || nodeDetail.getBoundingClientRect().top;
      e.preventDefault();
    });

    resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true;
      resizeStartX = e.clientX;
      resizeStartY = e.clientY;
      startWidth = nodeDetail.offsetWidth;
      startHeight = nodeDetail.offsetHeight;
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener('mousemove', (e) => {
      if (isDragging) {
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        const newX = Math.max(0, Math.min(window.innerWidth - nodeDetail.offsetWidth, elemStartX + dx));
        const newY = Math.max(0, Math.min(window.innerHeight - nodeDetail.offsetHeight, elemStartY + dy));
        nodeDetail.style.left = newX + 'px';
        nodeDetail.style.top = newY + 'px';
      }
      if (isResizing) {
        const dx = e.clientX - resizeStartX;
        const dy = e.clientY - resizeStartY;
        const newWidth = Math.max(280, Math.min(window.innerWidth - 400, startWidth + dx));
        const newHeight = Math.max(200, Math.min(window.innerHeight - 32, startHeight + dy));
        nodeDetail.style.width = newWidth + 'px';
        nodeDetail.style.height = newHeight + 'px';
      }
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      isResizing = false;
    });

    // Start
    init();
  </script>
</body>
</html>`;
}