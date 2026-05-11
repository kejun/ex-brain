// ---------------------------------------------------------------------------
// Public API — re-export from individual modules
// ---------------------------------------------------------------------------

export {
  SETTINGS_DIR,
  SETTINGS_PATH,
  DEFAULT_DB_PATH,
  expandTilde,
} from "./paths";

export {
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
} from "./schema";

export {
  type EnvSource,
  readSettingsFile,
  resolveSettings,
  loadSettings,
} from "./settings";

export {
  createDefaultSettings,
} from "./init";

// ---------------------------------------------------------------------------
// Slug utilities (from sibling file)
// ---------------------------------------------------------------------------

export {
  DEFAULT_DB_NAME,
  PAGES_COLLECTION,
  MAX_SLUG_LENGTH,
  nowIso,
  slugToTitle,
  inferTypeFromSlug,
  slugify,
  normalizeLongSlug,
} from "../slug-utils";
