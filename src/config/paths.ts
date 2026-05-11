import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Settings directory: ~/.ebrain */
export const SETTINGS_DIR = join(homedir(), ".ebrain");

/** Settings file path: ~/.ebrain/settings.json */
export const SETTINGS_PATH = join(SETTINGS_DIR, "settings.json");

/** Default database path: ~/.ebrain/data/ebrain.db */
export const DEFAULT_DB_PATH = resolve(SETTINGS_DIR, "data", "ebrain.db");

/**
 * Resolve a path that may start with ~ to the user's home directory.
 */
export function expandTilde(p: string): string {
  if (p.startsWith("~")) {
    return join(homedir(), p.slice(1));
  }
  return resolve(p);
}
