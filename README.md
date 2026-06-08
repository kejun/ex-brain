# ex-brain

CLI personal knowledge base built on [seekdb](https://docs.seekdb.ai/), featuring page management, hybrid search, timelines, tags, import/export, and MCP Server.

## Demo 

<video controls="true" width="800" height="438"><source src="https://obcommunityprod.oss-cn-shanghai.aliyuncs.com/prod/blog/2026-06/528cea12-2646-49bf-8d7c-74f94818c34b.mp4" type="video/mp4"></video>

## Core Features

- **Knowledge Graph Visualization** - Interactive 3D graph with entity relationships, labels, and Ask Ex-Brain Q&A
- **Intelligent Compilation** - Semantic analysis with smart Compiled Truth updates
- **Timeline Management** - Automatic event extraction and history tracking
- **Hybrid Search** - Full-text search + vector semantic queries
- **Entity Linking** - Auto-detect entities and create linked pages

<img src="https://mdn.alipayobjects.com/huamei_ytl0i7/afts/img/A*NGWjTJNpX18AAAAAgCAAAAgAejCYAQ/80p" width="800">

## Data Collection

We recommend [MarkSnip](https://chromewebstore.google.com/detail/kcbaglhfgbkjdnpeokaamjjkddempipm) for data collection:

- One-click web clipping to Markdown format
- Supports code blocks, tables, math formulas
- Local processing, privacy-friendly
- Obsidian integration support

Use with ex-brain:

```bash
# After clipping with MarkSnip, import to knowledge base
cat article.md | ebrain put articles/slug --stdin

# Or import HTML directly; ex-brain extracts the readable article and converts it to Markdown
ebrain put articles/html-page --file article.html
cat article.html | ebrain put articles/html-page --stdin --format html

# Or intelligent compilation
ebrain compile companies/river-ai --file article.md --source web_clip
```

## Installation

```bash
# Global installation (requires Bun or Node.js)
bun install -g ex-brain
# or
npm install -g ex-brain

ebrain --help
```

## Quick Start

### 1. Configure

```bash
# Initialize (creates ~/.ebrain/data/ebrain.db automatically)
ebrain init

# Check active config
ebrain config
```

Configure LLM and embeddings in `~/.ebrain/settings.json` if you want semantic search, AI compilation, and Ask Ex-Brain Q&A. Local hash embeddings work out of the box for lightweight use.

### 2. Import Knowledge

```bash
# Import Markdown or HTML directly
ebrain put my/note --file note.md
ebrain put articles/page --file article.html

# Pipe long content
cat article.md | ebrain put articles/slug --stdin
cat article.html | ebrain put articles/html-page --stdin --format html

# Batch import a directory
ebrain import ./docs --dry-run
ebrain import ./docs

# Compile + timeline + entity links in one command
ebrain smart-ingest companies/river-ai --file article.md
```

HTML input is extracted with Readability and converted to Markdown before storage, preserving readable structure, links, and images where possible.

### 3. Open Web UI

```bash
ebrain graph                    # Start graph Web UI (http://localhost:3000)
ebrain graph --port 8080 --open # Custom port and auto-open browser
```

### 4. Explore And Ask

Use the graph Web UI to search entities, filter by type, inspect node details, rename or merge entities, and explore relationships. Open **Ask Ex-Brain** from the graph toolbar to ask natural-language questions with sourced answers.

You can also query from the CLI:

```bash
ebrain search "some topic"
ebrain query "some question"
ebrain query --llm "What is the main idea of River AI's product?"
```

## Agent Integration With eBrain MCP

Start the MCP server:

```bash
ebrain serve
```

Configure your agent or MCP client:

```json
{
  "mcpServers": {
    "ebrain": {
      "command": "ebrain",
      "args": ["serve"]
    }
  }
}
```

Agents can then use eBrain tools to read and write pages, search the knowledge base, compile new facts, create entity links, extract timelines, and ingest PDF / Word / HTML / text documents.

## Knowledge Graph Web UI

<img src="https://mdn.alipayobjects.com/huamei_ytl0i7/afts/img/A*C0wrTJMgBosAAAAAgBAAAAgAejCYAQ/80p" width="800">

Start the interactive 3D knowledge graph:

```bash
ebrain graph --open
```

The graph UI includes:

- Entity relationship visualization with type-based colors and clustering
- Search, type filters, fit view, node details, entity rename/merge actions
- Toggleable labels with performance-aware rendering for large graphs
- Important-node labels shown by default, plus nearby labels as you move the camera
- Lighter default links, with highlighted links preserved during focus/selection
- **Ask Ex-Brain** floating panel for sourced Q&A over the knowledge base
- Ask controls for answer font size, reset/re-ask, loading state, and draggable/resizable layout

## Configuration

Edit `~/.ebrain/settings.json`:

```jsonc
{
  "db": { "path": "~/.ebrain/data/ebrain.db" },
  "embed": {
    "provider": "hash",          // or "openai_compatible"
    "baseURL": "...",
    "model": "...",
    "dimensions": 1024,
    "apiKey": "sk-..."
  },
  "llm": {
    "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "model": "qwen-plus",
    "apiKey": "sk-..."
  },
  "extraction": {
    "confidenceThreshold": 0.7   // Entity extraction confidence (0~1)
  }
}
```

Run `ebrain config` to view active configuration. See [docs/ebrain-cli.md](docs/ebrain-cli.md) for details.

## AI Q&A (RAG)

Ask natural language questions and get answers based on your knowledge base:

```bash
# Basic Q&A
ebrain query --llm "What is the main idea of River AI's product?"

# Control context depth
ebrain query --llm "What happened in Q4?" --context-limit 3
```

How it works:

1. **Semantic Search** — Finds top matching pages for your question
2. **Multi-Layer Context Collection** — Builds rich context from:
   - **Page Content** — Compiled truth + timeline for each matched page
   - **Raw Documents** — Original imported documents (via `raw set`)
   - **Linked Pages** — Incoming and outgoing linked pages, filtered by semantic relevance to the question
3. **LLM Synthesis** — Generates a sourced answer with `[[slug|title]]` citations

Configure LLM in `~/.ebrain/settings.json`:

```json
{
  "llm": {
    "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "model": "qwen-plus",
    "apiKey": "sk-..."
  }
}
```

## Development

```bash
bun install
bun run src/cli.ts --help
bun test
```
