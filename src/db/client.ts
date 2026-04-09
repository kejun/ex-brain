import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { SeekdbAdminClient, SeekdbClient, DEFAULT_PORT, DEFAULT_USER } from "seekdb";
import type { Collection } from "seekdb";
import type { ResolvedSettings } from "../settings";
import { createBrainEmbeddingFunction } from "../ai/embed-factory";
import { DEFAULT_DB_NAME, PAGES_COLLECTION } from "../config";
import { SQL_SCHEMA } from "./schema";
import { DbError, wrapDbError, DbErrorCategory } from "./errors";

function useRemoteSeekdb(): boolean {
  return Boolean(process.env.EBRAIN_SEEKDB_HOST?.trim());
}

function seekdbPassword(): string {
  return process.env.EBRAIN_SEEKDB_PASSWORD ?? process.env.SEEKDB_PASSWORD ?? "";
}

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;
const RETRY_BACKOFF_FACTOR = 2;

export class BrainDb {
  private _isConnected = false;
  private _lastConnectedAt: Date | null = null;

  private constructor(
    public readonly dbPath: string,
    public readonly client: SeekdbClient,
    public readonly pagesCollection: Collection,
  ) {}

  /**
   * Check if the database is currently connected.
   */
  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Get the last successful connection timestamp.
   */
  get lastConnectedAt(): Date | null {
    return this._lastConnectedAt;
  }

  /**
   * Execute with automatic reconnection on failure.
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
  ): Promise<T> {
    let lastError: DbError | null = null;

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const result = await operation();
        if (!this._isConnected) {
          this._isConnected = true;
          this._lastConnectedAt = new Date();
        }
        return result;
      } catch (error) {
        const wrappedError = wrapDbError(error, operationName as any);
        lastError = wrappedError;

        // Only retry on connection/timeout errors
        if (!wrappedError.isRetryable() || attempt === MAX_RETRY_ATTEMPTS) {
          throw wrappedError;
        }

        // Check if it's a connection error that might be resolved by reconnecting
        if (wrappedError.category === DbErrorCategory.CONNECTION) {
          console.warn(
            `\x1b[33m[DB]\x1b[0m Connection error on attempt ${attempt}/${MAX_RETRY_ATTEMPTS}, retrying...`,
          );
          await this.attemptReconnect();
        } else {
          // Exponential backoff for other retryable errors
          const delay = RETRY_DELAY_MS * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1);
          console.warn(
            `\x1b[33m[DB]\x1b[0m ${operationName} failed on attempt ${attempt}/${MAX_RETRY_ATTEMPTS}, retrying in ${delay}ms...`,
          );
          await this.sleep(delay);
        }
      }
    }

    throw lastError;
  }

  private async attemptReconnect(): Promise<void> {
    try {
      // Test if we can execute a simple query
      await this.client.execute("SELECT 1");
      this._isConnected = true;
      this._lastConnectedAt = new Date();
      console.error("\x1b[32m[DB] Reconnected successfully\x1b[0m");
    } catch {
      // Connection still failed, will retry on next operation
      this._isConnected = false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  static async connect(dbPath: string, settings?: ResolvedSettings): Promise<BrainDb> {
    try {
      const client = settings?.remote
        ? await BrainDb.openRemoteClient(settings.remote)
        : useRemoteSeekdb()
          ? await BrainDb.openRemoteClientFromEnv()
          : await BrainDb.openEmbeddedClient(dbPath);

      // Test connection with a simple query
      await client.execute("SELECT 1");

      for (const sql of SQL_SCHEMA) {
        await client.execute(sql);
      }

      const pagesCollection = await client.getOrCreateCollection({
        name: PAGES_COLLECTION,
        embeddingFunction: createBrainEmbeddingFunction(settings?.embed),
      });

      const db = new BrainDb(dbPath, client, pagesCollection);
      db._isConnected = true;
      db._lastConnectedAt = new Date();
      console.error("\x1b[32m[DB] Connected successfully\x1b[0m");
      return db;
    } catch (error) {
      const wrappedError = wrapDbError(error, "connect");
      console.error(`\x1b[31m[DB]\x1b[0m Connection failed:`, wrappedError.toJSON());
      throw wrappedError;
    }
  }

  private static async openEmbeddedClient(dbPath: string): Promise<SeekdbClient> {
    await mkdir(dirname(dbPath), { recursive: true });
    const admin = new SeekdbAdminClient({ path: dbPath });
    try {
      await admin.createDatabase(DEFAULT_DB_NAME);
      await admin.getDatabase(DEFAULT_DB_NAME);
    } catch (error) {
      try {
        await admin.getDatabase(DEFAULT_DB_NAME);
      } catch {
        throw error;
      }
    }

    return new SeekdbClient({
      path: dbPath,
      database: DEFAULT_DB_NAME,
    });
  }

  private static async openRemoteClient(remote: NonNullable<ResolvedSettings["remote"]>): Promise<SeekdbClient> {
    const args: ConstructorParameters<typeof SeekdbClient>[0] = {
      host: remote.host,
      port: remote.port,
      user: remote.user,
      password: remote.password,
      database: remote.database,
    };
    if (remote.tenant) {
      args.tenant = remote.tenant;
    }
    return new SeekdbClient(args);
  }

  private static async openRemoteClientFromEnv(): Promise<SeekdbClient> {
    const host = process.env.EBRAIN_SEEKDB_HOST!.trim();
    const port = Number(process.env.EBRAIN_SEEKDB_PORT ?? DEFAULT_PORT);
    const user = process.env.EBRAIN_SEEKDB_USER ?? DEFAULT_USER;
    const database =
      process.env.EBRAIN_SEEKDB_DATABASE?.trim() || DEFAULT_DB_NAME;
    const tenant = process.env.EBRAIN_SEEKDB_TENANT?.trim();
    const args: ConstructorParameters<typeof SeekdbClient>[0] = {
      host,
      port,
      user,
      password: seekdbPassword(),
      database,
    };
    if (tenant) {
      args.tenant = tenant;
    }
    return new SeekdbClient(args);
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
      this._isConnected = false;
      console.error("\x1b[32m[DB] Disconnected\x1b[0m");
    } catch (error) {
      const wrappedError = wrapDbError(error, "close");
      console.error(`\x1b[31m[DB]\x1b[0m Error closing connection:`, wrappedError.message);
      // Don't throw on close errors - best effort
    }
  }
}
