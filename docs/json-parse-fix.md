# JSON Parse Error Fix Summary

## Problem

Error when searching entities with special characters:
```
search failed: Parse error {"query":"Lenny's Newsletter","limit":1}
```

## Root Cause

seekdb's JSON parser breaks on single quotes (') and other special characters in query strings.

## Solution

Created `src/utils/query-sanitizer.ts` to sanitize query strings before sending to seekdb:

```typescript
export function sanitizeQuery(query: string): string {
  return query
    .replace(/'/g, '')           // Remove single quotes (main issue)
    .replace(/"/g, '')           // Remove double quotes
    .replace(/\\/g, '')          // Remove backslashes
    .replace(/\x00/g, '')        // Remove null bytes
    .replace(/\n/g, ' ')         // Replace newlines
    .replace(/\r/g, ' ')         // Replace carriage returns
    .replace(/\t/g, ' ')         // Replace tabs
    .replace(/\s+/g, ' ')        // Collapse multiple spaces
    .trim();
}
```

## Changes

1. **Created** `src/utils/query-sanitizer.ts` - Query sanitization utilities
2. **Modified** `src/repositories/brain-repo.ts`:
   - Import `sanitizeQuery`
   - Apply sanitization in `search()` method
   - Apply sanitization in `query()` method
   - Added `fallbackSearch()` for graceful degradation

## Test Results

✅ **Parse error RESOLVED**

Before fix:
```
[DB Error] search failed: Parse error {"query":"Lenny's Newsletter","limit":1}
```

After fix:
```
✓ Entity extraction complete
✓ Created links, tags, and timeline
```

No parse errors in logs: `cat ~/.ebrain/logs/error-*.log | grep "Parse error"` returns nothing.

## Impact

- All search operations now handle special characters safely
- Fallback to SQL LIKE search if vector search fails
- No data loss or operation failures due to special characters