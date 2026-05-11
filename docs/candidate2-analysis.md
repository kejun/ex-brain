# Candidate 2 Deepening Analysis: commands/index.ts Split

## 1. Command Inventory (2541 lines total)

### Commands by size (largest first):

| Command | Lines | % of file | Complexity | Subcommands |
|---|---|---|---|---|
| **import** | ~404 | 15.9% | 🔴 High (5-phase pipeline: scan→parse→write→entity→index) | none |
| **put** | ~336 | 13.2% | 🔴 High (dual branch: document ingestion vs markdown, entity links, timeline) | none |
| **timeline** | ~168 | 6.6% | 🟡 Medium (4 subcommands, LLM extraction) | list, add, extract, global |
| **raw** | ~119 | 4.7% | 🟢 Low (2 subcommands, thin repo wrappers) | get, set |
| **init** | ~104 | 4.1% | 🟡 Medium (3-step setup flow, dynamic imports) | none |
| **query** | ~89 | 3.5% | 🔴 High (multi-layer context collection + LLM streaming) | none |
| **embed** | ~89 | 3.5% | 🟢 Low (--all vs single slug, thin repo wrapper) | none |
| **tag** | ~74 | 2.9% | 🟢 Low (3 subcommands, thin repo wrappers) | list, add, remove |
| **config** | ~50 | 2.0% | 🟢 Low (settings dump) | none |
| **delete** | ~47 | 1.9% | 🟢 Low (withRepo + repo.deletePage) | none |
| **list** | ~46 | 1.8% | 🟢 Low (withRepo + repo.listPages + format) | none |
| **link** | ~38 | 1.5% | 🟢 Low (withRepo + repo.link) | none |
| **get** | ~35 | 1.4% | 🟢 Low (withRepo + repo.getPage + render) | none |
| **tools-json** | ~33 | 1.3% | 🟢 Low (static JSON dump) | none |
| **stats** | ~37 | 1.5% | 🟢 Low (withRepo + repo.stats) | none |
| **export** | ~39 | 1.5% | 🟢 Low (withRepo + loop write) | none |
| **backlinks** | ~20 | 0.8% | 🟢 Low (withRepo + repo.backlinks) | none |
| **search** | ~25 | 1.0% | 🟢 Low (withRepo + repo.search) | none |
| **serve** | ~16 | 0.6% | 🟢 Low (dynamic import + start server) | none |

### Helper sections:

| Section | Lines | Purpose |
|---|---|---|
| Imports | 1-26 | 26 import lines |
| Top helpers | 28-196 | addDryRun, isDryRun, contentHash, progress, **applyEntityLinks** (77 lines), resolveInput |
| Bottom helpers | 1976-2541 | withRepo, print, isJson, formatHuman, normalizeLinkSlug, **collectContextForLLM** (~170 lines), **generateAnswerWithStream** (~200 lines), **generateAnswerWithContext** (deprecated, ~130 lines) |

---

## 2. Shared Patterns Identified

### Pattern A: `withRepo` + `print(program, ...)` skeleton
**Used by**: config, get, delete, list, search, query, link, backlinks, timeline (all subcmds), tag (all subcmds), raw (all subcmds), embed, stats, export
**Pattern**:
```typescript
await withRepo(program, async (repo) => {
  const jsonOut = isJson(program);
  // ... command logic using repo ...
  print(program, { ok: true, ... });
});
```
**Observation**: This is the dominant architectural pattern. Commands are **shallow** — they pass through to repo methods with minor formatting. Deleting any one of these commands would not make complexity reappear elsewhere; they're thin adapters.

### Pattern B: `addDryRun` wrapper
**Used by**: put, delete, link, timeline add, timeline extract, tag add, tag remove, raw set, embed, import
**Pattern**:
```typescript
addDryRun(program.command("...")).action(async (..., opts: { dryRun?: boolean }) => {
  if (isDryRun(opts)) { print(program, { dryRun: true, ... }); return; }
  // real logic
});
```

### Pattern C: Spinner + header + keyValue + success workflow
**Used by**: put, import, query, embed, init, stats
**Pattern**: Non-JSON output with `createSpinner()`, `header()`, `keyValue()`, `spinner.start()`, `spinner.succeed()`, `success()`.

### Pattern D: Entity extraction (`applyEntityLinks`)
**Used by**: put (both branches), import (two loops: md files + doc files)
**Coupling**: `applyEntityLinks` is defined in top helpers (77 lines) but only called from put and import. It pulls in `loadSettings`, `extractRelations`, `entityToSlug` — it has a narrow interface but significant implementation.

### Pattern E: LLM Answer Generation
**Used by**: query command only
**Coupling**: `collectContextForLLM` (~170 lines), `computeKeywordRelevance` (~20 lines), `generateAnswerWithStream` (~200 lines), `generateAnswerWithContext` (~130 lines, deprecated). These are ~520 lines of LLM-specific logic, tightly coupled only to the query command.

### Pattern F: `isDocumentFile` + `DOC_EXTENSIONS`
**Used by**: put command (branch detection), import command (file collection)
**Coupling**: Defined inside `buildProgram()` scope, used by both put and import.

### Pattern G: `normalizeLinkSlug`
**Used by**: import command only (wiki link normalization)
**Coupling**: Defined at bottom of file, only consumed by import.

---

## 3. Deletion Test Results

| Candidate Module | Delete it → complexity vanishes? | Delete it → complexity reappears in callers? | Verdict |
|---|---|---|---|
| Simple commands (get, delete, list, search, link, backlinks, stats, export, serve, tools-json, config) | ✅ Yes | ❌ No | **Pass-through** — thin adapters |
| put (~336 lines) | ❌ No | ✅ Yes (caller would need to handle document vs markdown branching, entity links, timeline, idempotency hash) | **Earns its keep** — but currently too deep in the wrong place (in a giant file) |
| import (~404 lines) | ❌ No | ✅ Yes (caller would need 5-phase pipeline logic) | **Earns its keep** — same issue as put |
| query (~89 lines + ~520 lines LLM helpers) | ❌ No | ✅ Yes (multi-layer context collection is non-trivial) | **Earns its keep** — but LLM helpers are bloated |
| timeline (~168 lines) | ❌ No | ✅ Yes (but modestly — 4 subcommands could each be thin) | **Moderate** — subcommand group earns its keep |
| applyEntityLinks (77 lines) | ❌ No | ✅ Yes (put and import both depend on it) | **Good candidate for extraction** |
| withRepo/print/isJson/formatHuman (38 lines) | ❌ No | ✅ Yes (every command uses these) | **Shared seam** — perfect for shared.ts |

---

## 4. Proposed Split Architecture

```
src/commands/
├── index.ts              (~40 lines) — buildProgram() only, imports and registers all command modules
├── shared.ts             (~80 lines) — withRepo, print, isJson, formatHuman, addDryRun, isDryRun, progress
├── put-cmd.ts            (~350 lines) — put command (dual branch: document ingestion + markdown)
├── import-cmd.ts         (~420 lines) — import command (5-phase pipeline)
├── query-cmd.ts          (~200 lines) — query command + LLM answer generation (streaming)
├── timeline-cmd.ts       (~170 lines) — timeline subcommands (list, add, extract, global)
├── tag-cmd.ts            (~80 lines)  — tag subcommands (list, add, remove)
├── raw-cmd.ts            (~120 lines) — raw subcommands (get, set)
├── crud-cmd.ts           (~180 lines) — get, delete, list, config (grouped: thin CRUD + config)
├── link-cmd.ts           (~60 lines)  — link, backlinks (grouped: link operations)
├── embed-cmd.ts          (~90 lines)  — embed command
├── init-cmd.ts           (~105 lines) — init command
├── export-cmd.ts         (~40 lines)  — export command
├── search-cmd.ts         (~30 lines)  — search command
├── serve-cmd.ts          (~50 lines)  — serve, tools-json (grouped: server commands)
├── entity-links.ts       (~80 lines)  — applyEntityLinks (extracted from helpers, shared by put + import)
├── compile-cmd.ts        (existing)   — compile, smart-ingest
└── graph-cmd.ts          (existing)   — graph
```

### Why these groupings:

- **crud-cmd.ts**: get/delete/list/config are each <50 lines, share the same `withRepo + print` pattern. Grouping avoids file proliferation for modules that individually would be too shallow to warrant a file.
- **link-cmd.ts**: link + backlinks are two sides of the same coin (creating vs querying links).
- **serve-cmd.ts**: serve + tools-json are both MCP-server-related.
- **entity-links.ts**: Shared seam between put and import. Both need entity extraction. This is the clearest "two adapters = real seam" case.

---

## 5. Depth Analysis (Interface vs Implementation)

### After split, expected depth per module:

| Module | Interface (caller needs to know) | Implementation (hidden behind interface) | Depth |
|---|---|---|---|
| **put-cmd** | `registerPutCommand(program)` | Document ingestion, markdown parsing, entity linking, idempotency, timeline | 🟢 Deep — tiny interface, rich implementation |
| **import-cmd** | `registerImportCommand(program)` | 5-phase pipeline, batch operations, entity extraction, search indexing | 🟢 Deep — tiny interface, rich implementation |
| **query-cmd** | `registerQueryCommand(program)` | Multi-layer context collection, LLM streaming, keyword relevance scoring | 🟢 Deep — tiny interface, rich implementation |
| **entity-links** | `applyEntityLinks(repo, slug, content, json)` | LLM settings loading, confidence filtering, entity page creation, linking | 🟡 Moderate — interface is clear, implementation is substantial |
| **shared** | `withRepo(program, cb)`, `print(program, payload)`, `isJson(program)`, `addDryRun(cmd)`, `isDryRun(opts)`, `progress(label, cur, total, json)` | DB connection lifecycle, JSON formatting, spinner creation, dry-run gating | 🟡 Moderate — interface is the size of the module, but locality improves dramatically |
| **crud-cmd** | `registerCrudCommands(program)` | Page reading, deletion, listing, config display | 🟡 Moderate — implementation is thin (repo pass-through), but grouping gives locality |
| **timeline-cmd** | `registerTimelineCommand(program)` | Timeline CRUD + LLM extraction | 🟡 Moderate — extraction subcommand adds depth |
| **tag-cmd**, **raw-cmd**, **embed-cmd**, **link-cmd**, **init-cmd**, **export-cmd**, **search-cmd**, **serve-cmd** | `registerXxxCommand(s)(program)` | Repo method calls + output formatting | 🔴 Shallow — interface nearly as complex as implementation. Acceptable for CLI commands (they ARE adapters). |

---

## 6. Helper Extraction Analysis

### withRepo
**Current**: Defined at bottom of index.ts (lines 1976-2000). Duplicated in compile-cmd.ts.
**Problem**: Two copies of the same lifecycle logic. compile-cmd.ts version lacks flush-and-exit comment.
**Solution**: Move to `shared.ts`. Single source of truth for DB connection lifecycle.
**Impact**: All commands import from shared. compile-cmd.ts removes its duplicate.

### print / isJson / formatHuman
**Current**: Defined at bottom of index.ts.
**Problem**: Every command depends on these for output formatting.
**Solution**: Move to `shared.ts`.
**Impact**: Clean separation of output concerns.

### addDryRun / isDryRun
**Current**: addDryRun at line 28, isDryRun at line 32. isDryRun duplicated in compile-cmd.ts.
**Solution**: Move to `shared.ts`.
**Impact**: Single source of truth for dry-run pattern.

### applyEntityLinks
**Current**: Lines 47-122 in index.ts (77 lines). Called by put (2 locations) and import (2 locations).
**Problem**: Tightly coupled to `BrainRepository`, `loadSettings`, `extractRelations`, `entityToSlug`. Has its own spinner, timing, and output logic mixed in.
**Solution**: Extract to `entity-links.ts`. Consider splitting: pure entity extraction logic vs. output/formatting.
**Depth after extraction**: Interface is 4 parameters. Implementation is 77 lines. Good depth.

### LLM Answer Generation (collectContextForLLM, generateAnswerWithStream, generateAnswerWithContext)
**Current**: Lines 2014-2541 (~527 lines). Only used by query command.
**Problem**: Massive block at end of file. Deprecated `generateAnswerWithContext` still present.
**Solution**: Move to `query-cmd.ts` (or separate `llm-answer.ts` if query-cmd gets too large).
**Depth**: These are deep — rich implementation behind a simple `generateAnswerWithStream(question, sections, stats, llm)` interface.

### progress (simple helper)
**Current**: Line 42-45.
**Solution**: Move to `shared.ts`.

### contentHash
**Current**: Lines 36-38. Used by put and import.
**Solution**: Could go to `shared.ts` or a new `hash-utils.ts`. Given its simplicity, `shared.ts` is fine.

### resolveInput
**Current**: Lines 191-194. Only used by put.
**Solution**: Keep in `put-cmd.ts`.

### isDocumentFile / DOC_EXTENSIONS
**Current**: Lines 247-253. Used by put and import.
**Solution**: Move to `shared.ts` or a new `document-types.ts`.

### normalizeLinkSlug
**Current**: Lines 2009-2013. Only used by import.
**Solution**: Keep in `import-cmd.ts`.

---

## 7. File Structure (Final) and Split Order

### Phase 1: Extract shared utilities (no command logic changes)
1. Create `src/commands/shared.ts`
   - Move: `withRepo`, `print`, `isJson`, `formatHuman`, `addDryRun`, `isDryRun`, `progress`, `contentHash`, `isDocumentFile`, `DOC_EXTENSIONS`
   - Export all
2. Update `src/commands/index.ts` to import from shared
3. Update `src/commands/compile-cmd.ts` to import `withRepo`, `isDryRun`, `print` from shared (remove duplicates)
4. Verify: `bun test` or manual smoke test

### Phase 2: Extract entity-links (shared by put + import)
5. Create `src/commands/entity-links.ts`
   - Move: `applyEntityLinks` function + its imports
6. Update `index.ts` and `put-cmd.ts`/`import-cmd.ts` (after they're split) to import

### Phase 3: Extract LLM query logic (deep module)
7. Create `src/commands/query-cmd.ts`
   - Move: query command action + `collectContextForLLM`, `computeKeywordRelevance`, `ContextSection`, `ContextStats`, `generateAnswerWithStream`
   - Drop: deprecated `generateAnswerWithContext`
   - Export: `registerQueryCommand(program: Command): void`
8. Remove from `index.ts`, import from query-cmd.ts

### Phase 4: Split large commands (put, import)
9. Create `src/commands/put-cmd.ts`
   - Move: put command action (~336 lines)
   - Export: `registerPutCommand(program: Command): void`
10. Create `src/commands/import-cmd.ts`
    - Move: import command action + `collectMarkdownFilesFromPaths`, `collectDocumentFilesFromPaths`, `normalizeLinkSlug` (~404 lines)
    - Export: `registerImportCommand(program: Command): void`

### Phase 5: Group thin commands (reduce file proliferation)
11. Create `src/commands/crud-cmd.ts` — config, get, delete, list
12. Create `src/commands/link-cmd.ts` — link, backlinks
13. Create `src/commands/serve-cmd.ts` — serve, tools-json
14. Create `src/commands/timeline-cmd.ts` — timeline + subcommands
15. Create `src/commands/tag-cmd.ts` — tag + subcommands
16. Create `src/commands/raw-cmd.ts` — raw + subcommands
17. Create `src/commands/embed-cmd.ts` — embed
18. Create `src/commands/init-cmd.ts` — init
19. Create `src/commands/export-cmd.ts` — export
20. Create `src/commands/search-cmd.ts` — search

### Phase 6: Clean up index.ts
21. Reduce `index.ts` to ~40 lines: imports + `buildProgram()` that calls all `register*Command()` functions

---

## 8. Locality & Leverage Improvements

### Before split:
- **Locality**: 🔴 Poor — understanding `put` requires scanning 2541 lines to find the relevant section. Entity extraction logic is 800 lines away from where it's called.
- **Leverage**: 🟡 Moderate — `withRepo` and `print` are leveraged by all commands but buried in the same file.
- **Testability**: 🔴 Poor — cannot test individual commands without loading the entire program. `applyEntityLinks` and LLM helpers are not independently testable.

### After split:
- **Locality**: 🟢 Excellent — each command is one file. Entity extraction has its own module. LLM answer generation is isolated.
- **Leverage**: 🟢 Good — `shared.ts` concentrates lifecycle/output concerns. `entity-links.ts` concentrates entity extraction.
- **Testability**: 🟢 Good — each command module exports a registration function that can be tested in isolation. Entity extraction and LLM answer generation become independently testable.

### Key deepening wins:
1. **entity-links.ts** becomes a deep module: 4-parameter interface, 77-line implementation, shared by 2 commands.
2. **query-cmd.ts** becomes a deep module: 1-parameter interface (register), ~400 lines of context collection + LLM streaming behind it.
3. **put-cmd.ts** and **import-cmd.ts** become deep modules: each has a 1-parameter interface but encapsulates complex multi-step workflows.
4. **shared.ts** improves locality: all lifecycle and output helpers in one place, imported by all commands.
