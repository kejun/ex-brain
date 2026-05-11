import { createHash } from "node:crypto";
import { Command } from "commander";
import { BrainDb } from "../db/client";
import { BrainRepository } from "../repositories/brain-repo";
import { loadSettings } from "../settings";

// ---------------------------------------------------------------------------
// Dry-run helpers
// ---------------------------------------------------------------------------

export function addDryRun(cmd: Command): Command {
  return cmd.option("--dry-run", "preview changes without executing", false);
}

export function isDryRun(opts: Record<string, unknown>): boolean {
  return Boolean(opts.dryRun);
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

/**
 * Compute a short SHA-256 hex hash of a string (first 16 chars).
 * Used for detecting duplicate document ingestion.
 */
export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

export function isJson(program: Command): boolean {
  return Boolean(program.opts().json);
}

function formatHuman(payload: unknown): string {
  if (Array.isArray(payload)) {
    return payload
      .map((item) =>
        typeof item === "string"
          ? `- ${item}`
          : `- ${JSON.stringify(item)}`,
      )
      .join("\n");
  }
  return JSON.stringify(payload, null, 2);
}

export function print(program: Command, payload: unknown): void {
  if (isJson(program)) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (typeof payload === "string") {
    console.log(payload);
    return;
  }
  console.log(formatHuman(payload));
}

// ---------------------------------------------------------------------------
// Database session helper
// ---------------------------------------------------------------------------

/**
 * Open a database connection, run the callback, then exit.
 *
 * DO NOT call db.close() — seekdb's embedded native close() segfaults.
 * seekdb is an embedded database; data is flushed to WAL on each transaction.
 * For remote mode, the server handles cleanup; for embedded, process.exit
 * is safe and avoids the native crash.
 */
export async function withRepo(
  program: Command,
  callback: (repo: BrainRepository) => Promise<void>,
): Promise<void> {
  const settings = await loadSettings();
  const cliDb = program.opts().db;
  const dbPath = cliDb ?? settings.dbPath;
  const db = await BrainDb.connect(dbPath, settings);
  const repo = new BrainRepository(db);
  await callback(repo);

  // Flush stdout/stderr buffers so results are visible
  await new Promise<void>((r) => {
    process.stdout.write("", () => {
      process.stderr.write("", () => r());
    });
  });

  // Exit code 139 (segfault) from seekdb's atexit hooks in the native
  // embedded server — unavoidable without upstream fix.
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Link slug normalization (used by import/wiki-link processing)
// ---------------------------------------------------------------------------

export function normalizeLinkSlug(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\.\.\//g, "")
    .replace(/\.md$/, "");
}
