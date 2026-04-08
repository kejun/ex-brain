import { OpenAIEmbeddingFunction } from "@seekdb/openai";
import type { EmbeddingFunction } from "seekdb";
import type { ResolvedEmbed } from "../settings";
import { LocalHashEmbeddingFunction } from "./hash-embed";

/**
 * 嵌入服务：与 seekdb 业务库（EBRAIN_SEEKDB_*）分离，仅由 EBRAIN_EMBED_* 控制。
 * - `hash`（默认）：本地确定性向量，无网络。
 * - `openai_compatible`：OpenAI 兼容 HTTP 端（如 DashScope compatible-mode）。
 */
export function createBrainEmbeddingFunction(cfg?: ResolvedEmbed): EmbeddingFunction {
  // Fallback to env vars when no resolved settings passed
  if (!cfg) {
    return createFromEnv();
  }

  if (cfg.provider !== "openai_compatible") {
    return new LocalHashEmbeddingFunction();
  }

  // Workaround: seekdb's Schema.fromJSON loads stored embedding function config
  // (e.g. { name: "openai", properties: {} }) and instantiates it WITHOUT
  // the API key. Setting OPENAI_API_KEY ensures seekdb can instantiate it.
  if (cfg.apiKey) {
    process.env.OPENAI_API_KEY = cfg.apiKey;
  }

  if (!cfg.apiKey) {
    const fromEnv = process.env[cfg.apiKeyEnv]?.trim();
    if (!fromEnv) {
      console.warn(
        `[ebrain] embed provider=openai_compatible but no API key; falling back to hash.`,
      );
      return new LocalHashEmbeddingFunction();
    }
    process.env.OPENAI_API_KEY = fromEnv;
    return new OpenAIEmbeddingFunction({
      baseURL: cfg.baseURL,
      modelName: cfg.model,
      dimensions: cfg.dimensions,
      apiKeyEnvVar: cfg.apiKeyEnv,
    });
  }

  return new OpenAIEmbeddingFunction({
    baseURL: cfg.baseURL,
    modelName: cfg.model,
    dimensions: cfg.dimensions,
    apiKey: cfg.apiKey,
  });
}

// ---------------------------------------------------------------------------
// Legacy fallback: read directly from env vars (backward compatible)
// ---------------------------------------------------------------------------

const DEFAULT_DASHSCOPE_COMPAT_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_EMBED_MODEL = "text-embedding-v4";
const DEFAULT_EMBED_DIMENSIONS = 1024;
const DEFAULT_KEY_ENV = "DASHSCOPE_API_KEY";

function createFromEnv(): EmbeddingFunction {
  const provider = (process.env.EBRAIN_EMBED_PROVIDER ?? "hash")
    .trim()
    .toLowerCase();
  if (provider !== "openai_compatible") {
    return new LocalHashEmbeddingFunction();
  }

  const baseURL =
    process.env.EBRAIN_EMBED_BASE_URL?.trim() || DEFAULT_DASHSCOPE_COMPAT_URL;
  const modelName =
    process.env.EBRAIN_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL;
  const dimensionsRaw = process.env.EBRAIN_EMBED_DIMENSIONS?.trim();
  const dimensions = dimensionsRaw
    ? Number(dimensionsRaw)
    : DEFAULT_EMBED_DIMENSIONS;
  if (!Number.isFinite(dimensions) || dimensions <= 0) {
    throw new Error(
      `[ebrain] EBRAIN_EMBED_DIMENSIONS must be a positive number, got: ${dimensionsRaw}`,
    );
  }

  const directKey = process.env.EBRAIN_EMBED_API_KEY?.trim();
  const keyEnv =
    process.env.EBRAIN_EMBED_API_KEY_ENV?.trim() || DEFAULT_KEY_ENV;
  const fromNamedEnv = process.env[keyEnv]?.trim();
  const resolvedKey = directKey || fromNamedEnv;

  if (!resolvedKey) {
    console.warn(
      `[ebrain] EBRAIN_EMBED_PROVIDER=openai_compatible but no API key (set EBRAIN_EMBED_API_KEY or ${keyEnv}); falling back to hash embedding.`,
    );
    return new LocalHashEmbeddingFunction();
  }

  // Set OPENAI_API_KEY for seekdb's Schema.fromJSON fallback
  process.env.OPENAI_API_KEY = resolvedKey;

  if (directKey) {
    return new OpenAIEmbeddingFunction({
      baseURL,
      modelName,
      dimensions,
      apiKey: directKey,
    });
  }

  return new OpenAIEmbeddingFunction({
    baseURL,
    modelName,
    dimensions,
    apiKeyEnvVar: keyEnv,
  });
}
