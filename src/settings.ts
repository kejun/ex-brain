/**
 * @deprecated Import from "./config" instead.
 * This file exists only for backward compatibility.
 */
export {
  SETTINGS_DIR,
  SETTINGS_PATH,
  DEFAULT_DB_PATH,
  SettingsSchema,
  RemoteDbSchema,
  EmbedSchema,
  LLMSchema,
  type RawSettings,
  type ResolvedSettings,
  type ResolvedExtraction,
  type ResolvedRemoteDb,
  type ResolvedEmbed,
  type ResolvedLLM,
  DEFAULT_REMOTE,
  DEFAULT_EMBED,
  DEFAULT_LLM,
  DEFAULT_EXTRACTION,
  type EnvSource,
  readSettingsFile,
  resolveSettings,
  loadSettings,
  createDefaultSettings,
  expandTilde,
} from "./config";
