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
  }
}
```

Run `ebrain config` to view active configuration. See [docs/ebrain-cli.md](docs/ebrain-cli.md) for details.

## Development

```bash
bun install
bun run src/cli.ts --help
bun test
```