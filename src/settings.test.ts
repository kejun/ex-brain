import { describe, expect, test, afterEach } from "bun:test";
import { homedir } from "node:os";
import { resolveSettings } from "./settings";

describe("resolveSettings", () => {
  // Save and restore env
  const originalEnv = { ...process.env };

  function resetEnv() {
    // Remove all EBRAIN_ vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("EBRAIN_")) {
        delete process.env[key];
      }
    }
  }

  afterEach(() => {
    resetEnv();
    // Restore original
    for (const key of Object.keys(originalEnv)) {
      process.env[key] = originalEnv[key]!;
    }
    // Remove any added keys
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
  });

  describe("defaults", () => {
    test("empty config resolves to local hash mode", () => {
      const s = resolveSettings({});
      expect(s.remote).toBeNull();
      expect(s.embed.provider).toBe("hash");
      expect(s.embed.dimensions).toBe(1024);
      expect(s.embed.baseURL).toBe(
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
      );
      expect(s.embed.model).toBe("text-embedding-v4");
      expect(s.embed.apiKey).toBe("");
      expect(s.embed.apiKeyEnv).toBe("DASHSCOPE_API_KEY");
    });

    test("default db path points to ~/.ebrain/data/ebrain.db", () => {
      const s = resolveSettings({});
      const home = homedir();
      expect(s.dbPath).toBe(`${home}/.ebrain/data/ebrain.db`);
    });
  });

  describe("db path", () => {
    test("resolves absolute path", () => {
      const s = resolveSettings({ db: { path: "/tmp/test.db" } });
      expect(s.dbPath).toBe("/tmp/test.db");
    });

    test("expands ~ to home dir", () => {
      const s = resolveSettings({ db: { path: "~/data/ebrain.db" } });
      expect(s.dbPath).toBe(`${homedir()}/data/ebrain.db`);
    });

    test("expands ~/.ebrain prefix correctly", () => {
      const s = resolveSettings({ db: { path: "~/.ebrain/custom.db" } });
      expect(s.dbPath).toBe(`${homedir()}/.ebrain/custom.db`);
    });

    test("resolves relative path from cwd", () => {
      const s = resolveSettings({ db: { path: "data/my.db" } });
      expect(s.dbPath).toMatch(/\/data\/my\.db$/);
    });
  });

  describe("remote mode", () => {
    test("enabled when settings.json has remote.host", () => {
      const s = resolveSettings({
        db: { remote: { host: "127.0.0.1" } },
      });
      expect(s.remote).not.toBeNull();
      expect(s.remote!.host).toBe("127.0.0.1");
    });

    test("enabled when EBRAIN_SEEKDB_HOST env var is set", () => {
      process.env.EBRAIN_SEEKDB_HOST = "db.example.com";
      const s = resolveSettings({});
      expect(s.remote).not.toBeNull();
      expect(s.remote!.host).toBe("db.example.com");
    });

    test("settings remote.host overrides env var", () => {
      process.env.EBRAIN_SEEKDB_HOST = "env-host";
      const s = resolveSettings({
        db: { remote: { host: "settings-host" } },
      });
      expect(s.remote!.host).toBe("settings-host");
    });

    test("remote uses defaults for missing fields", () => {
      const s = resolveSettings({
        db: { remote: { host: "127.0.0.1" } },
      });
      expect(s.remote!.port).toBe(3306);
      expect(s.remote!.user).toBe("root");
      expect(s.remote!.password).toBe("");
      expect(s.remote!.database).toBe("ebrain");
      expect(s.remote!.tenant).toBe("");
    });

    test("remote overrides all fields", () => {
      const s = resolveSettings({
        db: {
          remote: {
            host: "10.0.0.1",
            port: 3307,
            user: "admin",
            password: "secret",
            database: "mybrain",
            tenant: "team-a",
          },
        },
      });
      expect(s.remote!.host).toBe("10.0.0.1");
      expect(s.remote!.port).toBe(3307);
      expect(s.remote!.user).toBe("admin");
      expect(s.remote!.password).toBe("secret");
      expect(s.remote!.database).toBe("mybrain");
      expect(s.remote!.tenant).toBe("team-a");
    });

    test("env vars fill in missing remote fields", () => {
      process.env.EBRAIN_SEEKDB_HOST = "host-from-env";
      process.env.EBRAIN_SEEKDB_PORT = "5432";
      process.env.EBRAIN_SEEKDB_USER = "envuser";
      // Empty string host + no remote config → env var triggers remote mode
      const s = resolveSettings({});
      expect(s.remote!.host).toBe("host-from-env");
      expect(s.remote!.port).toBe(5432);
      expect(s.remote!.user).toBe("envuser");
    });
  });

  describe("embed config", () => {
    test("hash provider is default", () => {
      const s = resolveSettings({});
      expect(s.embed.provider).toBe("hash");
    });

    test("settings override embed provider", () => {
      const s = resolveSettings({
        embed: { provider: "openai_compatible" },
      });
      expect(s.embed.provider).toBe("openai_compatible");
    });

    test("env var overrides embed provider when not in settings", () => {
      process.env.EBRAIN_EMBED_PROVIDER = "openai_compatible";
      const s = resolveSettings({});
      expect(s.embed.provider).toBe("openai_compatible");
    });

    test("all embed fields default correctly for openai_compatible", () => {
      const s = resolveSettings({ embed: { provider: "openai_compatible" } });
      expect(s.embed.baseURL).toBe(
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
      );
      expect(s.embed.model).toBe("text-embedding-v4");
      expect(s.embed.dimensions).toBe(1024);
    });

    test("settings override embed base URL and model", () => {
      const s = resolveSettings({
        embed: {
          provider: "openai_compatible",
          baseURL: "https://api.openai.com/v1",
          model: "text-embedding-3-small",
          dimensions: 1536,
        },
      });
      expect(s.embed.baseURL).toBe("https://api.openai.com/v1");
      expect(s.embed.model).toBe("text-embedding-3-small");
      expect(s.embed.dimensions).toBe(1536);
    });

    test("env var overrides embed dimensions", () => {
      process.env.EBRAIN_EMBED_DIMENSIONS = "512";
      const s = resolveSettings({});
      expect(s.embed.dimensions).toBe(512);
    });

    test("settings apiKey is respected", () => {
      const s = resolveSettings({
        embed: { provider: "openai_compatible", apiKey: "sk-test" },
      });
      expect(s.embed.apiKey).toBe("sk-test");
    });

    test("env var EBRAIN_EMBED_API_KEY used when settings apiKey is undefined", () => {
      process.env.EBRAIN_EMBED_API_KEY = "env-key";
      const s = resolveSettings({
        embed: { provider: "openai_compatible" },
      });
      expect(s.embed.apiKey).toBe("env-key");
    });

    test("apiKeyEnv defaults to DASHSCOPE_API_KEY", () => {
      const s = resolveSettings({});
      expect(s.embed.apiKeyEnv).toBe("DASHSCOPE_API_KEY");
    });

    test("apiKeyEnv can be overridden", () => {
      const s = resolveSettings({
        embed: { apiKeyEnv: "MY_CUSTOM_KEY" },
      });
      expect(s.embed.apiKeyEnv).toBe("MY_CUSTOM_KEY");
    });

    test("trims whitespace from values", () => {
      const s = resolveSettings({
        embed: {
          provider: "  openai_compatible  ",
          baseURL: "  https://example.com  ",
          model: "  my-model  ",
          apiKey: "  sk-trimmed  ",
        },
      });
      expect(s.embed.provider).toBe("openai_compatible");
      expect(s.embed.baseURL).toBe("https://example.com");
      expect(s.embed.model).toBe("my-model");
      expect(s.embed.apiKey).toBe("sk-trimmed");
    });
  });

  describe("priority chain", () => {
    test("settings > env > defaults for db path", () => {
      process.env.EBRAIN_SEEKDB_HOST = ""; // empty, won't trigger remote
      const s = resolveSettings({ db: { path: "/settings.db" } });
      expect(s.dbPath).toBe("/settings.db");
      expect(s.remote).toBeNull();
    });

    test("remote mode: settings > env for each field", () => {
      process.env.EBRAIN_SEEKDB_HOST = "env-host";
      process.env.EBRAIN_SEEKDB_PORT = "9999";
      const s = resolveSettings({
        db: { remote: { host: "settings-host", port: 3306 } },
      });
      expect(s.remote!.host).toBe("settings-host");
      expect(s.remote!.port).toBe(3306);
    });

    test("local mode db path is set even with remote config but no host", () => {
      const s = resolveSettings({
        db: {
          path: "/local.db",
          remote: {}, // no host
        },
      });
      expect(s.dbPath).toBe("/local.db");
      expect(s.remote).toBeNull();
    });
  });

  describe("llm config", () => {
    test("defaults when not configured", () => {
      const s = resolveSettings({});
      expect(s.llm.baseURL).toBe("");
      expect(s.llm.model).toBe("qwen-plus");
      expect(s.llm.apiKey).toBe("");
      expect(s.llm.apiKeyEnv).toBe("DASHSCOPE_API_KEY");
    });

    test("settings override all fields", () => {
      const s = resolveSettings({
        llm: {
          baseURL: "https://api.openai.com/v1",
          model: "gpt-4o",
          apiKey: "sk-openai-key",
        },
      });
      expect(s.llm.baseURL).toBe("https://api.openai.com/v1");
      expect(s.llm.model).toBe("gpt-4o");
      expect(s.llm.apiKey).toBe("sk-openai-key");
    });

    test("apiKeyEnv defaults to DASHSCOPE_API_KEY", () => {
      const s = resolveSettings({});
      expect(s.llm.apiKeyEnv).toBe("DASHSCOPE_API_KEY");
    });

    test("apiKeyEnv can be overridden", () => {
      const s = resolveSettings({
        llm: { apiKeyEnv: "MY_LLM_KEY" },
      });
      expect(s.llm.apiKeyEnv).toBe("MY_LLM_KEY");
    });

    test("trims whitespace from values", () => {
      const s = resolveSettings({
        llm: {
          baseURL: "  https://example.com/v1  ",
          model: "  qwen-plus  ",
          apiKey: "  sk-trimmed  ",
        },
      });
      expect(s.llm.baseURL).toBe("https://example.com/v1");
      expect(s.llm.model).toBe("qwen-plus");
      expect(s.llm.apiKey).toBe("sk-trimmed");
    });

    test("empty baseURL means not configured", () => {
      const s = resolveSettings({ llm: {} });
      expect(s.llm.baseURL).toBe("");
    });
  });
});
