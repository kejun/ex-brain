/**
 * Sanitize query strings for seekdb to prevent JSON parse errors.
 * 
 * seekdb's internal parser has issues with certain characters:
 * - Single quotes break JSON string parsing
 * - Control characters may crash the native module
 * - Special characters need proper escaping
 */

/**
 * Sanitize a search query string for safe use with seekdb.
 * Removes or replaces characters that cause parse errors.
 */
export function sanitizeQuery(query: string): string {
  if (!query || typeof query !== 'string') {
    return '';
  }
  
  return query
    // Remove problematic characters that break JSON parsing
    .replace(/'/g, '')           // Remove single quotes (main issue)
    .replace(/"/g, '')           // Remove double quotes
    .replace(/\\/g, '')          // Remove backslashes
    .replace(/\x00/g, '')        // Remove null bytes
    
    // Replace control characters with spaces
    .replace(/\n/g, ' ')         // Replace newlines
    .replace(/\r/g, ' ')         // Replace carriage returns
    .replace(/\t/g, ' ')         // Replace tabs
    
    // Collapse multiple spaces into one
    .replace(/\s+/g, ' ')
    
    // Trim leading/trailing whitespace
    .trim();
}

/**
 * Fallback search using SQL LIKE when vector search fails.
 * More robust but less accurate than vector search.
 */
export function safeSearchPattern(query: string): string {
  const sanitized = sanitizeQuery(query);
  
  // For SQL LIKE, we need to escape % and _ wildcards
  return sanitized
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

/**
 * Validate that a query string is safe for seekdb operations.
 * Returns true if the query is safe, false otherwise.
 */
export function isQuerySafe(query: string): boolean {
  if (!query || query.length === 0) {
    return false;
  }
  
  // Check for characters that cause parse errors
  const dangerousChars = /['"\\\x00]/;
  return !dangerousChars.test(query);
}