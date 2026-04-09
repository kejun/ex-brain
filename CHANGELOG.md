# Changelog

All notable changes to ex-brain will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **LLM Client Module** (`src/ai/llm-client.ts`): Unified LLM calling with retry mechanism (exponential backoff, max 3 retries), error classification (APIError/TimeoutError/RateLimitError), and common `resolveApiKey` and `callLLM` functions.
- **Database Error Handling**: Added `DbError`, `wrapDbError`, and `DbErrorCategory` types in `src/db/errors.ts` for unified error handling across database operations.
- **Batch Operations**: Performance optimizations for `embedAll`, `timelineAddBatch`, and import commands with bulk operations.
- **CLI Output Utilities** (`src/utils/cli-output.ts`): Colorful, structured CLI output with:
  - Green success messages (✓), red errors (✗), yellow warnings (⚠)
  - Spinner animations with automatic cleanup for native error visibility
  - Environment variable `EBRAIN_NO_SPINNER=1` to disable spinner for debugging
  - Task status tracking (working → [done])
  - Detailed step-by-step feedback
- **Query Sanitizer** (`src/utils/query-sanitizer.ts`): Sanitizes query strings before sending to seekdb, handling special characters (quotes, backslashes, control characters) that previously caused JSON parse errors. Includes fallback to SQL LIKE search when vector search fails.
- **JSON Repair for LLM Parsing** (`jsonrepair` dependency): Handles unterminated strings and malformed JSON from LLM responses, preventing parse failures during entity extraction.
- **Confidence Threshold Setting**: New `extraction.confidenceThreshold` in settings.json (default `0.7`) with environment variable `EBRAIN_CONFIDENCE_THRESHOLD` for fine-grained control over entity extraction quality.
- **`--skip-index` Option for Import**: Allows skipping vector indexing during import to avoid seekdb native library crashes. Useful when working with large batches or on systems where the native module is unstable.
- **`smart-ingest` Command**: Combines `put`, timeline extraction, and entity linking in a single intelligent ingestion workflow.

### Changed

- **AI Module Refactoring**: Refactored `compiler.ts`, `timeline-extractor.ts`, and `entity-link.ts` to use the unified LLM client.
- **API Key Resolution**: Centralized API key resolution logic in `llm-client.ts`.
- **Database Client**: Added retry mechanism with automatic reconnection. DB logs redirected to stderr for cleaner output.
- **CLI Commands**: Improved output formatting for `put`, `delete`, `ingest`, `import`, `embed`, `stats` commands with detailed progress and status information.
- **Entity Extraction Pipeline**:
  - Confidence threshold filtering (configurable, default 0.7)
  - Graceful error handling — extraction failures no longer crash the entire operation
  - Detailed entity creation and linking summaries in CLI output
  - Improved changeType mapping for proper entity type classification
  - Date parsing improvements and importance field support
- **Multi-Layer Context for LLM Query**: `ebrain query --llm` now builds richer context from page content, raw documents, and semantically-filtered linked pages (incoming and outgoing).
- **MCP Server**: Added global error handling for all MCP tools.
- **Database Operations**: Added `db.close()` before process exit to attempt data flush.

### Fixed

- Entity type mapping (changeType) for proper info type classification.
- Confidence threshold filtering for entity extraction.
- Native library errors (OB_ABORT) now display clearly without being overwritten by spinner.
- JSON parse errors caused by special characters (single quotes, etc.) in search queries.
- LLM JSON response parsing — handles unterminated strings and other malformed output.

### Known Issues

- seekdb embedded library may return exit code 139 (SIGSEGV) on process exit on macOS. This is a known issue and JSON output remains valid. Use remote mode (`EBRAIN_SEEKDB_HOST`) for stable exit codes, or use `ebrain import --skip-index` to skip vector indexing during bulk imports.

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