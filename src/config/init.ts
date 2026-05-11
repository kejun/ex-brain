import { SETTINGS_PATH, SETTINGS_DIR } from "./paths";
import { fileExists } from "../markdown/io";
import { mkdirSync, writeFileSync } from "node:fs";

/**
 * Generate a minimal settings.json if it doesn't already exist.
 * Returns true if a new file was created.
 */
export async function createDefaultSettings(): Promise<boolean> {
  if (await fileExists(SETTINGS_PATH)) {
    return false;
  }

  mkdirSync(SETTINGS_DIR, { recursive: true });

  // All fields present but empty — user fills in their values
  const defaults = {
    db: {
      path: "",
      remote: {
        host: "",
        port: 0,
        user: "",
        password: "",
        database: "",
        tenant: "",
      },
    },
    embed: {
      provider: "hash",
      baseURL: "",
      model: "",
      dimensions: 0,
      apiKey: "",
      apiKeyEnv: "",
    },
    llm: {
      baseURL: "",
      model: "",
      apiKey: "",
      apiKeyEnv: "",
    },
    extraction: {
      confidenceThreshold: 0.7,
    },
  };

  writeFileSync(SETTINGS_PATH, JSON.stringify(defaults, null, 2) + "\n", "utf-8");
  return true;
}
