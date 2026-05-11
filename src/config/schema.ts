import { z } from "zod";

// ---------------------------------------------------------------------------
// Raw schema (matches settings.json structure)
// ---------------------------------------------------------------------------

export const RemoteDbSchema = z.object({
  host: z.string().optional(),
  port: z.number().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  database: z.string().optional(),
  tenant: z.string().optional(),
});

export const EmbedSchema = z.object({
  provider: z.enum(["hash", "openai_compatible"]).optional(),
  baseURL: z.string().optional(),
  model: z.string().optional(),
  dimensions: z.number().optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
});

export const LLMSchema = z.object({
  baseURL: z.string().optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
});

export const SettingsSchema = z.object({
  db: z
    .object({
      path: z.string().optional(),
      remote: RemoteDbSchema.optional(),
    })
    .optional(),
  embed: EmbedSchema.optional(),
  llm: LLMSchema.optional(),
  extraction: z
    .object({
      confidenceThreshold: z.number().min(0).max(1).optional(),
    })
    .optional(),
});

export type RawSettings = z.infer<typeof SettingsSchema>;

// ---------------------------------------------------------------------------
// Resolved types (all values present after defaults + env merge)
// ---------------------------------------------------------------------------

export interface ResolvedSettings {
  dbPath: string;
  remote: ResolvedRemoteDb | null;
  embed: ResolvedEmbed;
  llm: ResolvedLLM;
  extraction: ResolvedExtraction;
}

export interface ResolvedExtraction {
  confidenceThreshold: number;
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
// Default values
// ---------------------------------------------------------------------------

export const DEFAULT_REMOTE: Omit<ResolvedRemoteDb, "host"> = {
  port: 3306,
  user: "root",
  password: "",
  database: "ebrain",
  tenant: "",
};

export const DEFAULT_EMBED: Omit<ResolvedEmbed, "provider"> & { provider: "hash" } = {
  provider: "hash",
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "text-embedding-v4",
  dimensions: 1024,
  apiKey: "",
  apiKeyEnv: "DASHSCOPE_API_KEY",
};

export const DEFAULT_LLM: ResolvedLLM = {
  baseURL: "",
  model: "qwen-plus",
  apiKey: "",
  apiKeyEnv: "DASHSCOPE_API_KEY",
};

export const DEFAULT_EXTRACTION: ResolvedExtraction = {
  confidenceThreshold: 0.7,
};
