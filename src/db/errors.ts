/**
 * Database error types and utilities.
 * Provides unified error handling for all database operations.
 */

/**
 * Database error categories
 */
export const DbErrorCategory = {
  CONNECTION: "CONNECTION",
  QUERY: "QUERY",
  SCHEMA: "SCHEMA",
  VALIDATION: "VALIDATION",
  NOT_FOUND: "NOT_FOUND",
  CONSTRAINT: "CONSTRAINT",
  TIMEOUT: "TIMEOUT",
  UNKNOWN: "UNKNOWN",
} as const;

export type DbErrorCategory = (typeof DbErrorCategory)[keyof typeof DbErrorCategory];

/**
 * Database operation types for error context
 */
export type DbOperation =
  | "getPage"
  | "putPage"
  | "listPages"
  | "deletePage"
  | "search"
  | "query"
  | "syncPageToSearch"
  | "syncPagesToSearch"
  | "embedAll"
  | "link"
  | "unlink"
  | "timeline"
  | "timelineAdd"
  | "timelineAddBatch"
  | "timelineDelete"
  | "timelineUpdate"
  | "timelineGlobal"
  | "tags"
  | "tag"
  | "untag"
  | "readRaw"
  | "writeRaw"
  | "backlinks"
  | "allSlugs"
  | "stats"
  | "findSimilarSlug"
  | "ensureEntityPage"
  | "compilePage"
  | "extractAndAddTimeline"
  | "ingestContent"
  | "init"
  | "connect"
  | "close";

/**
 * Unified database error class
 */
export class DbError extends Error {
  constructor(
    message: string,
    public readonly category: DbErrorCategory,
    public readonly operation: DbOperation,
    public readonly dbCause?: unknown,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "DbError";
    // Maintains proper stack trace in V8 (Node.js)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DbError);
    }
  }

  /**
   * Check if this error is retryable
   */
  isRetryable(): boolean {
    return this.retryable;
  }

  /**
   * Convert to JSON for logging
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      category: this.category,
      operation: this.operation,
      retryable: this.retryable,
      dbCause: this.dbCause instanceof Error
        ? { name: this.dbCause.name, message: this.dbCause.message }
        : this.dbCause,
      stack: this.stack,
    };
  }
}

/**
 * Create database error from any caught exception
 */
export function wrapDbError(
  error: unknown,
  operation: DbOperation,
  context?: Record<string, unknown>,
): DbError {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error : undefined;

  // Determine error category and retryability based on error message/type
  let category: DbErrorCategory = "UNKNOWN";
  let retryable = false;

  const errorStr = message.toLowerCase();

  if (
    errorStr.includes("connect") ||
    errorStr.includes("connection") ||
    errorStr.includes("econnrefused") ||
    errorStr.includes("etimedout") ||
    errorStr.includes("network")
  ) {
    category = "CONNECTION";
    retryable = true;
  } else if (
    errorStr.includes("timeout") ||
    errorStr.includes("timed out")
  ) {
    category = "TIMEOUT";
    retryable = true;
  } else if (
    errorStr.includes("not found") ||
    errorStr.includes("no such table") ||
    errorStr.includes("no such database")
  ) {
    category = "NOT_FOUND";
  } else if (
    errorStr.includes("constraint") ||
    errorStr.includes("duplicate") ||
    errorStr.includes("unique")
  ) {
    category = "CONSTRAINT";
  } else if (
    errorStr.includes("syntax") ||
    errorStr.includes("parse") ||
    errorStr.includes("invalid")
  ) {
    category = "VALIDATION";
  } else if (
    errorStr.includes("schema") ||
    errorStr.includes("column")
  ) {
    category = "SCHEMA";
  } else {
    category = "QUERY";
  }

  const fullMessage = context
    ? `${operation} failed: ${message} ${JSON.stringify(context)}`
    : `${operation} failed: ${message}`;

  return new DbError(fullMessage, category, operation, cause, retryable);
}

/**
 * Log database error with context
 */
export function logDbError(
  error: DbError,
  logger: { error: (msg: string, meta?: Record<string, unknown>) => void } = console,
): void {
  logger.error("[DB Error]", error.toJSON());
}