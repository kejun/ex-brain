import { SETTINGS_PATH, SETTINGS_DIR, expandTilde, DEFAULT_DB_PATH } from "./paths";
import {
  SettingsSchema,
  DEFAULT_REMOTE,
  DEFAULT_EMBED,
  DEFAULT_LLM,
  DEFAULT_EXTRACTION,
  type RawSettings,
  type ResolvedSettings,
  type ResolvedRemoteDb,
  type ResolvedEmbed,
  type ResolvedLLM,
  type ResolvedExtraction,
} from "./schema";

// ---------------------------------------------------------------------------
// Env abstraction for testability
// ---------------------------------------------------------------------------

export interface EnvSource {
  get(key: string): string | undefined;
}

const defaultEnv: EnvSource = { get: (k) => process.env[k] };

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

export async function readSettingsFile(): Promise<unknown | null> {
  const { fileExists, readTextFile } = await import("../markdown/io");
  if (!(await fileExists(SETTINGS_PATH))) {
    return null;
  }
  const text = await readTextFile(SETTINGS_PATH);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    console.warn(
      `[ebrain] Failed to parse ${SETTINGS_PATH}, using defaults.`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Resolution: raw settings + env → resolved settings
// ---------------------------------------------------------------------------

export function resolveSettings(
  parsed: RawSettings,
  env: EnvSource = defaultEnv,
): ResolvedSettings {
  const dbConf = parsed.db ?? {};
  const remoteConf = dbConf.remote ?? {};
  const embedConf = parsed.embed ?? {};
  const extractionConf = parsed.extraction ?? {};

  // Remote: settings → env → defaults
  const host = nonEmpty(remoteConf.host ?? env.get("EBRAIN_SEEKDB_HOST"), "");
  if (host) {
    const remote: ResolvedRemoteDb = {
      host: host.trim(),
      port: numOr(remoteConf.port ?? env.get("EBRAIN_SEEKDB_PORT"), DEFAULT_REMOTE.port),
      user: nonEmpty(remoteConf.user ?? env.get("EBRAIN_SEEKDB_USER"), DEFAULT_REMOTE.user),
      password: nonEmpty(
        remoteConf.password ?? env.get("EBRAIN_SEEKDB_PASSWORD"),
        DEFAULT_REMOTE.password,
      ),
      database: nonEmpty(
        remoteConf.database ?? env.get("EBRAIN_SEEKDB_DATABASE"),
        DEFAULT_REMOTE.database,
      ),
      tenant: nonEmpty(remoteConf.tenant ?? env.get("EBRAIN_SEEKDB_TENANT"), ""),
    };
    return {
      dbPath: dbConf.path ?? DEFAULT_DB_PATH,
      remote,
      embed: resolveEmbed(embedConf, env),
      llm: resolveLLM(parsed.llm ?? {}, env),
      extraction: resolveExtraction(extractionConf, env),
    };
  }

  // Local mode
  const dbPath = dbConf.path ? expandTilde(dbConf.path) : DEFAULT_DB_PATH;
  return {
    dbPath,
    remote: null,
    embed: resolveEmbed(embedConf, env),
    llm: resolveLLM(parsed.llm ?? {}, env),
    extraction: resolveExtraction(extractionConf, env),
  };
}

function resolveEmbed(
  conf: NonNullable<RawSettings["embed"]>,
  env: EnvSource = defaultEnv,
): ResolvedEmbed {
  const provider = nonEmpty(
    conf.provider ?? env.get("EBRAIN_EMBED_PROVIDER"),
    DEFAULT_EMBED.provider,
  ).trim().toLowerCase() as "hash" | "openai_compatible";
  const baseURL = nonEmpty(conf.baseURL ?? env.get("EBRAIN_EMBED_BASE_URL"), DEFAULT_EMBED.baseURL);
  const model = nonEmpty(conf.model ?? env.get("EBRAIN_EMBED_MODEL"), DEFAULT_EMBED.model);
  const dimensions = numOr(conf.dimensions ?? env.get("EBRAIN_EMBED_DIMENSIONS"), DEFAULT_EMBED.dimensions);
  const apiKey = nonEmpty(conf.apiKey ?? env.get("EBRAIN_EMBED_API_KEY"), "");
  const apiKeyEnv = nonEmpty(conf.apiKeyEnv ?? env.get("EBRAIN_EMBED_API_KEY_ENV"), DEFAULT_EMBED.apiKeyEnv);
  return { provider, baseURL, model, dimensions, apiKey, apiKeyEnv };
}

function resolveLLM(
  conf: NonNullable<RawSettings["llm"]>,
  env: EnvSource = defaultEnv,
): ResolvedLLM {
  const baseURL = nonEmpty(conf.baseURL, DEFAULT_LLM.baseURL);
  const model = nonEmpty(conf.model, DEFAULT_LLM.model);
  const apiKey = nonEmpty(conf.apiKey, DEFAULT_LLM.apiKey);
  const apiKeyEnv = nonEmpty(conf.apiKeyEnv, DEFAULT_LLM.apiKeyEnv);
  return { baseURL, model, apiKey, apiKeyEnv };
}

function resolveExtraction(
  conf: NonNullable<RawSettings["extraction"]>,
  env: EnvSource = defaultEnv,
): ResolvedExtraction {
  const threshold = conf.confidenceThreshold ?? env.get("EBRAIN_CONFIDENCE_THRESHOLD");
  const value = typeof threshold === "number"
    ? threshold
    : (threshold ? parseFloat(threshold) : DEFAULT_EXTRACTION.confidenceThreshold);
  return { confidenceThreshold: Math.max(0, Math.min(1, value)) };
}

// ---------------------------------------------------------------------------
// Public load function
// ---------------------------------------------------------------------------

export async function loadSettings(
  env: EnvSource = defaultEnv,
): Promise<ResolvedSettings> {
  const raw = await readSettingsFile();
  const parsed = SettingsSchema.parse(raw ?? {});
  return resolveSettings(parsed, env);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nonEmpty(val: string | undefined, fallback: string): string {
  const trimmed = val?.trim();
  return trimmed || fallback;
}

function numOr(val: number | string | undefined, fallback: number): number {
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const n = Number(val.trim());
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Re-export paths for backward compatibility
// ---------------------------------------------------------------------------

export { SETTINGS_DIR, SETTINGS_PATH, DEFAULT_DB_PATH, expandTilde };
