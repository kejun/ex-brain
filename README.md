# ex-brain

CLI personal knowledge base built on [seekdb](https://docs.seekdb.ai/), featuring page management, hybrid search, timelines, tags, import/export, and MCP Server.

## Core Features

- **Knowledge Graph Visualization** - Interactive graph showing entity relationships
- **Intelligent Compilation** - Semantic analysis with smart Compiled Truth updates
- **Timeline Management** - Automatic event extraction and history tracking
- **Hybrid Search** - Full-text search + vector semantic queries
- **Entity Linking** - Auto-detect entities and create linked pages

<img src="https://mdn.alipayobjects.com/huamei_ytl0i7/afts/img/A*TqdfTZ-yCPwAAAAAgBAAAAgAejCYAQ/original" width="800">

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

```bash
# Initialize (creates ~/.ebrain/data/ebrain.db automatically)
ebrain init

# Write a page
ebrain put my/note --file note.md

# Knowledge graph visualization
ebrain graph                    # Start graph Web UI (http://localhost:3000)
ebrain graph --port 8080 --open # Custom port and auto-open browser

# Intelligently compile new information
ebrain compile companies/river-ai "River AI completed Series A funding" --source meeting_notes

# Extract timeline events from a page
ebrain timeline extract companies/river-ai

# Search
ebrain search "some topic"
ebrain query "some question"

# AI-powered Q&A with LLM (RAG)
ebrain query --llm "What is the main idea of River AI's product?"
ebrain query --llm "What are Mario Zechner's main views on game development?"

# Smart ingest: compile + timeline + entity links in one command
ebrain smart-ingest companies/river-ai --file article.md

# Start MCP Server (for AI tool integration)
ebrain serve
```

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
ex-brain query --llm "What is the main idea of River AI's product?"

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