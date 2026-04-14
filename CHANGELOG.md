# Changelog

All notable changes to ex-brain will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.4] - 2026-04-14

### Added

- **Streaming LLM Query Output**: `ebrain query --llm` now uses SSE streaming with real-time progress updates, showing data loading duration before streaming begins and progressive answer generation.

### Changed

- **Real-time Progress Callbacks**: Added progress callbacks to `collectContextForLLM` for real-time stage updates during context collection.

### Performance

- **Eliminated Redundant DB Queries**: `collectContextForLLM` no longer performs a second `repo.query()` for linked page scoring; uses keyword-based scoring and `pageCache` to avoid redundant `getPage()` calls.

## [0.2.3] - 2026-04-14

### Added

- **Ax Framework Integration** (`@ax-llm/ax`): Replaced all handwritten prompts with Ax Signature + GEPA optimization framework for better structured output.
- **Ax Adapter** (`src/ai/ax-adapter.ts`): New LLM adapter with `enable_thinking: false` fix for DashScope compatibility.
- **Integration Tests** (`src/ai/integration.test.ts`): 11 end-to-end tests covering compile, timeline, entity extraction, and full import workflow.
- **Benchmark Tools** (`benchmark.ts`): Visual HTML report generation for performance tracking.

### Changed

- **AI Module Major Refactor**: All AI modules now use Ax Signature framework:
  - `compiler.ts`: Ax Signature with `f.json()` output for multi-line markdown support
  - `entity-link.ts`: Ax Signature with `f.json()` output + Chinese entity support
  - `timeline-extractor.ts`: Ax Signature with `f.json()` output + Chinese date parsing
  - Deleted `llm-client.ts` (200 lines of manual fetch/retry/timeout replaced by Ax)
  - 44+ unit tests passing, 11 new integration tests

### Breaking Changes

- **AI Module Architecture**: Complete replacement of handwritten prompts with Ax Signature framework. The old `llm-client.ts` has been removed.

## [0.2.2] - 2026-04-14

### Added

- **`--version` / `-V` Flag**: Added version flag to `ebrain` CLI.

## [0.2.1] - 2026-04-14

### Fixed

- Corrected CLI command name from `ex-brain query` to `ebrain query` in README.

## [0.2.0] - 2026-04-14

### Added

- **Database Error Handling**: Added `DbError`, `wrapDbError`, and `DbErrorCategory` types in `src/db/errors.ts` for unified error handling.
- **Batch Operations**: Performance optimizations for `embedAll`, `timelineAddBatch`, and import commands with bulk operations.
- **CLI Output Utilities** (`src/utils/cli-output.ts`): Colorful, structured CLI output with spinner animations, task status tracking, and detailed step-by-step feedback.
- **Query Sanitizer** (`src/utils/query-sanitizer.ts`): Sanitizes query strings before sending to seekdb, with fallback to SQL LIKE search when vector search fails.
- **JSON Repair for LLM Parsing** (`jsonrepair` dependency): Handles unterminated strings and malformed JSON from LLM responses.
- **Confidence Threshold Setting**: New `extraction.confidenceThreshold` in settings.json (default `0.7`) with `EBRAIN_CONFIDENCE_THRESHOLD` env var.
- **`--skip-index` Option for Import**: Skips vector indexing during import to avoid seekdb native library crashes.
- **`smart-ingest` Command**: Combines `put`, timeline extraction, and entity linking in a single workflow.
- **Unified LLM Client** (`src/ai/llm-client.ts`): Centralized LLM client module for all AI operations.
- **MCP Global Error Handling**: Added global error handling for all MCP tools.

### Changed

- **Entity Extraction Pipeline**: Fixed skipping pages with tags, Ax `.max()` validation, Chinese field name handling, confidence threshold filtering, changeType mapping, date parsing, and importance field support.
- **Multi-Layer Context for LLM Query**: `ebrain query --llm` builds richer context from page content, raw documents, and semantically-filtered linked pages.
- **Database Client**: Added retry mechanism with automatic reconnection. DB logs redirected to stderr.
- **CLI Commands**: Improved output formatting for `put`, `delete`, `ingest`, `import`, `embed`, `stats` commands.
- **Database Operations**: Added `db.close()` before process exit to attempt data flush.

### Fixed

- Entity extraction skipping pages that already have tags
- Ax `.max()` validation blocking long content inputs
- Entity-link `parseRelations` handling Chinese field names from LLM output
- Entity type mapping (changeType) for proper info type classification
- Native library errors (OB_ABORT) now display clearly without being overwritten by spinner
- JSON parse errors caused by special characters in search queries
- LLM JSON response parsing — handles unterminated strings and malformed output

### Known Issues

- seekdb embedded library may return exit code 139 (SIGSEGV) on process exit on macOS. Use remote mode (`EBRAIN_SEEKDB_HOST`) or `ebrain import --skip-index` for stable exit codes.

## [0.1.0] - 2024-04-09

### Added

- Initial release with core features:
  - Page management (put, get, list, delete)
  - Hybrid search (full-text + vector)
  - Timeline management
  - Tags and backlinks
  - Import/Export markdown files
  - MCP Server integration
  - Knowledge graph visualization
  - Intelligent compilation with entity extraction
