import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";

export async function readMaybeStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text;
}

export async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const root = resolve(dir);
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const next = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(next);
      } else if (entry.isFile() && extname(entry.name) === ".md") {
        files.push(next);
      }
    }
  }
  await walk(root);
  return files.sort();
}

export function pathToSlug(filePath: string, rootDir: string): string {
  const rel = relative(resolve(rootDir), resolve(filePath));
  return rel.replace(/\.md$/, "").replaceAll("\\", "/");
}

export function slugToPath(slug: string, rootDir: string): string {
  return join(resolve(rootDir), `${slug}.md`);
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

export async function readTextFile(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile() || s.isDirectory();
  } catch {
    return false;
  }
}
