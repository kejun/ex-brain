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

### Changed

- **AI Module Refactoring**: Refactored `compiler.ts`, `timeline-extractor.ts`, and `entity-link.ts` to use the unified LLM client.
- **API Key Resolution**: Centralized API key resolution logic in `llm-client.ts`.
- **Database Client**: Added retry mechanism with automatic reconnection.
- **CLI Commands**: Improved output formatting for `put`, `delete`, `ingest`, `import`, `embed`, `stats` commands with detailed progress and status information.

### Fixed

- Entity type mapping (changeType) for proper info type classification.
- Confidence threshold filtering for entity extraction.
- Native library errors (OB_ABORT) now display clearly without being overwritten by spinner.

### Known Issues

- seekdb embedded library may return exit code 139 (SIGSEGV) on process exit on macOS. This is a known issue and JSON output remains valid. Use remote mode (`EBRAIN_SEEKDB_HOST`) for stable exit codes.

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