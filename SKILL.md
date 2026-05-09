---
name: ex-brain
description: CLI personal knowledge base tool with smart compilation, timeline management, entity linking, and hybrid search. Use this skill when users need to manage knowledge notes, compile information, establish entity relationships, extract timelines, or start the MCP Server.
---

# ex-brain

A local-first personal knowledge base CLI built on seekdb. Core capabilities: **smart compilation** of new information, **automatic timeline extraction**, **entity linking**, and **hybrid search**.

## Installation

```bash
bun install -g ex-brain
# or
npm install -g ex-brain

# Initialize database (creates ~/.ebrain/data/ebrain.db)
ebrain init
```

## Configuration

Edit `~/.ebrain/settings.json`:

```jsonc
{
  "db": { "path": "~/.ebrain/data/ebrain.db" },
  "embed": {
    "provider": "hash",              // or "openai_compatible"
    "baseURL": "...",                // embedding API URL
    "model": "text-embedding-v4",
    "dimensions": 1024,
    "apiKey": "",
    "apiKeyEnv": "DASHSCOPE_API_KEY" // read from environment variable
  },
  "llm": {
    "baseURL": "...",                // LLM API URL
    "model": "qwen-plus",
    "apiKeyEnv": "DASHSCOPE_API_KEY"
  }
}
```

Run `ebrain config` to view current configuration.

## Core Commands

### Page Management

```bash
# Write page (idempotent upsert)
ebrain put <slug> --file <path>
ebrain put <slug> --stdin           # pipe input
ebrain put <slug> --type <type> --content "content"

# Get page
ebrain get <slug>
ebrain get <slug> --json            # JSON output

# List pages
ebrain list [--type person] [--tag yc] [--limit 50]

# Delete page
ebrain delete <slug> [--dry-run]    # preview mode
```

### Smart Compilation (Core Feature)

Smart compilation analyzes new information, updates Compiled Truth, and extracts timeline events:

```bash
ebrain compile <slug> <info> --source <source> --date <date>

# Example
ebrain compile companies/river-ai \
  "River AI closed Series A, led by Sequoia, $50M" \
  --source meeting_notes \
  --date 2024-05-20
```

Compilation results:
- Status information (funding stage, CEO) → **Update**, old values archived to History
- Factual information (founding year, industry) → **Append** and retain
- Event information → **Record to timeline**

### Timeline

```bash
# View page timeline
ebrain timeline list <slug>

# Extract timeline events from page content (LLM semantic extraction)
ebrain timeline extract <slug>

# Manually add timeline event
ebrain timeline add <slug> --date YYYY-MM-DD --summary "..."
```

### Search

```bash
# Full-text search + vector semantic search (hybrid)
ebrain search <query> [--type person] [--limit 10]

# Pure semantic query
ebrain query <question> [--limit 10]

# Example
ebrain search "River AI funding"
ebrain query "Which companies recently raised funding?"
```

### Entity Linking

```bash
# Create link (idempotent)
ebrain link <from_slug> <to_slug> --context "relationship description"

# View backlinks
ebrain backlinks <slug>
```

### Tags

```bash
ebrain tag list <slug>
ebrain tag add <slug> <tag>         # idempotent
ebrain tag remove <slug> <tag>
```

### Page Creation (put)

`ebrain put` accepts markdown files **and** auto-detects non-markdown documents (PDF, DOCX, HTML, TXT, JSON) and http(s) URLs. Markdown files go through `parsePageMarkdown` (preserving frontmatter, timelines, wiki links); non-markdown files go through `loadDocument` for text extraction. Re-importing identical content is detected via content hash — the operation is instantly skipped without side-effects.

```bash
# Markdown (parsed with frontmatter/timeline/wiki-links)
ebrain put docs/api --file api.md

# PDF / DOCX / HTML / TXT / JSON (auto text extraction)
ebrain put --file report.pdf
ebrain put docs/report --file report.pdf  # explicit slug
ebrain put --file https://example.com/whitepaper.pdf
ebrain put --file article.docx --format text  # force format

# Pipe input
ebrain put my/note --stdin < note.md

# Dry-run preview
ebrain put --file report.pdf --dry-run
```

Each document ingest writes the extracted text to `compiled_truth`, records a timeline event, stores source metadata in the page frontmatter (`sourceFile`, `sourceType`, `sourceKind`, `sourceMimeType`, `sourceBytes`, parser stats, `_contentHash`), and a structured row in `raw_data` for traceability.

### Knowledge Graph Visualization

```bash
ebrain graph                        # Start on localhost:3000
ebrain graph --port 8080 --open     # Specify port and open browser
```

### MCP Server

```bash
ebrain serve                        # Start MCP Server
ebrain serve --db /path/to/db       # Specify database path
```

## MCP Configuration

Configure in Claude Desktop or other MCP clients:

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

### MCP Tools

| Tool | Function |
|-----|----------|
| `brain_get` | Get page content |
| `brain_put` | Create/update page |
| `brain_search` | Hybrid search |
| `brain_query` | Semantic query |
| `brain_compile` | Smart compile new information |
| `brain_link` | Create entity link |
| `brain_timeline_list` | View timeline |
| `brain_timeline_extract` | Extract timeline events |
| `brain_ingest_document` | Ingest a PDF / Word / HTML / text file or http(s) URL |

## Slug Naming Convention

Use `{type}/{name}` format:

- `companies/river-ai`
- `people/sarah-chen`
- `projects/alpha-launch`
- `notes/meeting-2024-05-20`

Types: `company`, `person`, `project`, `organization`, `event`, `note`, `other`

## Best Practices

### 1. Prefer Compilation Over Append

When encountering new information, prefer `compile` over direct `put`:

```bash
# Good: Let the system handle it smartly
ebrain compile companies/river-ai "new information" --source news

# Avoid: Simple append (information bloats)
ebrain put companies/river-ai --content "appended content"
```

### 2. Mark Information Source

Always mark the information source for traceability:

```bash
ebrain compile companies/river-ai "information" \
  --source meeting_notes \
  --date 2024-05-20
```

### 3. Type Classification

Specify type when writing pages for easier filtering:

```bash
ebrain put companies/river-ai --type company --file notes.md
ebrain put people/sarah-chen --type person --content "..."
```

### 4. Use Pipe Input

Suitable for scripts and automation:

```bash
cat notes.md | ebrain put my/note --stdin
curl -s https://api.example.com/data | ebrain raw set my/page --source api --stdin
```

### 5. JSON Output for Programmatic Processing

```bash
ebrain get companies/river-ai --json | jq '.compiledTruth'
ebrain list --type company --json | jq '.[] | .slug'
```

## Data Model

- `pages`: Knowledge pages (slug, type, title, compiled_truth, timeline)
- `links`: Entity relationships (from_slug, to_slug, context)
- `timeline_entries`: Timeline events (date, source, summary, detail)
- `page_tags`: Page tags
- `raw_data`: Raw data storage
- `ebrain_pages` (vector collection): For semantic search

## Tech Stack

- **Database**: seekdb (embedded database file)
- **Runtime**: Bun or Node.js
- **Embedding**: Local Hash or OpenAI Compatible API
- **LLM**: Ax Signature + GEPA framework (`@ax-llm/ax`) for smart compilation, timeline extraction, entity linking with structured `f.json()` output
- **AI Adapter**: Custom Ax adapter with DashScope compatibility (`enable_thinking: false`)

## References

- [seekdb Documentation](https://docs.seekdb.ai/)
- [Detailed CLI Documentation](./docs/ebrain-cli.md)
- [Timeline & Compilation Mechanism](./docs/timeline-compiled-truth.md)
- [Knowledge Graph Commands](./docs/graph-command.md)
- [Document Ingestion (PDF / Word / URL)](./docs/document-ingestion.md)