import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { fileExists, readTextFile } from "./markdown/io";

const SETTINGS_DIR = join(homedir(), ".ebrain");
export const SETTINGS_PATH = join(SETTINGS_DIR, "settings.json");
export const DEFAULT_DB_PATH = resolve(SETTINGS_DIR, "data", "ebrain.db");

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const RemoteDbSchema = z.object({
  host: z.string().optional(),
  port: z.number().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  database: z.string().optional(),
  tenant: z.string().optional(),
});

const EmbedSchema = z.object({
  provider: z.enum(["hash", "openai_compatible"]).optional(),
  baseURL: z.string().optional(),
  model: z.string().optional(),
  dimensions: z.number().optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
});

const LLMSchema = z.object({
  baseURL: z.string().optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
});

const SettingsSchema = z.object({
  db: z
    .object({
      path: z.string().optional(),
      remote: RemoteDbSchema.optional(),
    })
    .optional(),
  embed: EmbedSchema.optional(),
  llm: LLMSchema.optional(),
});

// ---------------------------------------------------------------------------
// Resolved types (all values present after defaults + env merge)
// ---------------------------------------------------------------------------

export interface ResolvedSettings {
  dbPath: string;
  remote: ResolvedRemoteDb | null;
  embed: ResolvedEmbed;
  llm: ResolvedLLM;
}

export interface ResolvedRemoteDb {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  tenant: string;
}

export interface ResolvedEmbed {
  provider: "hash" | "openai_compatible";
  baseURL: string;
  model: string;
  dimensions: number;
  apiKey: string;
  apiKeyEnv: string;
}

export interface ResolvedLLM {
  baseURL: string;
  model: string;
  apiKey: string;
  apiKeyEnv: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_REMOTE = {
  port: 3306,
  user: "root",
  password: "",
  database: "ebrain",
  tenant: "",
};

const DEFAULT_EMBED = {
  provider: "hash" as const,
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "text-embedding-v4",
  dimensions: 1024,
  apiKey: "",
  apiKeyEnv: "DASHSCOPE_API_KEY",
};

const DEFAULT_LLM = {
  baseURL: "",
  model: "qwen-plus",
  apiKey: "",
  apiKeyEnv: "DASHSCOPE_API_KEY",
};

// ---------------------------------------------------------------------------
// Load & resolve
// ---------------------------------------------------------------------------

export async function loadSettings(): Promise<ResolvedSettings> {
  const raw = await readSettingsFile();
  const parsed = SettingsSchema.parse(raw ?? {});
  return resolveSettings(parsed);
}

export async function readSettingsFile(): Promise<unknown | null> {
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

export function resolveSettings(parsed: z.infer<typeof SettingsSchema>): ResolvedSettings {
  const dbConf = parsed.db ?? {};
  const remoteConf = dbConf.remote ?? {};
  const embedConf = parsed.embed ?? {};

  // Remote: settings → env → defaults
  const host = remoteConf.host ?? process.env.EBRAIN_SEEKDB_HOST ?? "";
  if (host) {
    const remote: ResolvedRemoteDb = {
      host: host.trim(),
      port: numOr(remoteConf.port ?? process.env.EBRAIN_SEEKDB_PORT, DEFAULT_REMOTE.port),
      user: nonEmpty(remoteConf.user ?? process.env.EBRAIN_SEEKDB_USER, DEFAULT_REMOTE.user),
      password: nonEmpty(
        remoteConf.password ?? process.env.EBRAIN_SEEKDB_PASSWORD,
        DEFAULT_REMOTE.password,
      ),
      database: nonEmpty(
        remoteConf.database ?? process.env.EBRAIN_SEEKDB_DATABASE,
        DEFAULT_REMOTE.database,
      ),
      tenant: nonEmpty(remoteConf.tenant ?? process.env.EBRAIN_SEEKDB_TENANT, ""),
    };
    return { dbPath: dbConf.path ?? DEFAULT_DB_PATH, remote, embed: resolveEmbed(embedConf), llm: resolveLLM(parsed.llm ?? {}) };
  }

  // Local mode
  const dbPath = dbConf.path
    ? resolvePath(dbConf.path)
    : DEFAULT_DB_PATH;
  return { dbPath, remote: null, embed: resolveEmbed(embedConf), llm: resolveLLM(parsed.llm ?? {}) };
}

function resolveEmbed(conf: z.infer<typeof EmbedSchema>): ResolvedEmbed {
  const provider = nonEmpty(
    conf.provider ?? process.env.EBRAIN_EMBED_PROVIDER,
    DEFAULT_EMBED.provider,
  ).trim().toLowerCase() as "hash" | "openai_compatible";
  const baseURL = nonEmpty(conf.baseURL ?? process.env.EBRAIN_EMBED_BASE_URL, DEFAULT_EMBED.baseURL);
  const model = nonEmpty(conf.model ?? process.env.EBRAIN_EMBED_MODEL, DEFAULT_EMBED.model);
  const dimensions = numOr(conf.dimensions ?? process.env.EBRAIN_EMBED_DIMENSIONS, DEFAULT_EMBED.dimensions);
  const apiKey = nonEmpty(conf.apiKey ?? process.env.EBRAIN_EMBED_API_KEY, "");
  const apiKeyEnv = nonEmpty(conf.apiKeyEnv ?? process.env.EBRAIN_EMBED_API_KEY_ENV, DEFAULT_EMBED.apiKeyEnv);
  return { provider, baseURL, model, dimensions, apiKey, apiKeyEnv };
}

function resolveLLM(conf: z.infer<typeof LLMSchema>): ResolvedLLM {
  const baseURL = nonEmpty(conf.baseURL, DEFAULT_LLM.baseURL);
  const model = nonEmpty(conf.model, DEFAULT_LLM.model);
  const apiKey = nonEmpty(conf.apiKey, DEFAULT_LLM.apiKey);
  const apiKeyEnv = nonEmpty(conf.apiKeyEnv, DEFAULT_LLM.apiKeyEnv);
  return { baseURL, model, apiKey, apiKeyEnv };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nonEmpty(val: string | undefined, fallback: string): string {
  return val?.trim() ?? fallback;
}

function numOr(val: number | string | undefined, fallback: number): number {
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const n = Number(val.trim());
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return join(homedir(), p.slice(1));
  }
  return resolve(p);
}
