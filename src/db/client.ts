import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { SeekdbAdminClient, SeekdbClient, DEFAULT_PORT, DEFAULT_USER } from "seekdb";
import type { Collection } from "seekdb";
import type { ResolvedSettings } from "../settings";
import { createBrainEmbeddingFunction } from "../ai/embed-factory";
import { DEFAULT_DB_NAME, PAGES_COLLECTION } from "../config";
import { SQL_SCHEMA } from "./schema";

function useRemoteSeekdb(): boolean {
  return Boolean(process.env.EBRAIN_SEEKDB_HOST?.trim());
}

function seekdbPassword(): string {
  return process.env.EBRAIN_SEEKDB_PASSWORD ?? process.env.SEEKDB_PASSWORD ?? "";
}

export class BrainDb {
  private constructor(
    public readonly dbPath: string,
    public readonly client: SeekdbClient,
    public readonly pagesCollection: Collection,
  ) {}

  static async connect(dbPath: string, settings?: ResolvedSettings): Promise<BrainDb> {
    const client = settings?.remote
      ? await BrainDb.openRemoteClient(settings.remote)
      : useRemoteSeekdb()
        ? await BrainDb.openRemoteClientFromEnv()
        : await BrainDb.openEmbeddedClient(dbPath);

    for (const sql of SQL_SCHEMA) {
      await client.execute(sql);
    }

    const pagesCollection = await client.getOrCreateCollection({
      name: PAGES_COLLECTION,
      embeddingFunction: createBrainEmbeddingFunction(settings?.embed),
    });

    return new BrainDb(dbPath, client, pagesCollection);
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
    await this.client.close();
  }
}
