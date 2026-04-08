#!/usr/bin/env bun
import { buildProgram } from "./commands";

async function main(): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(process.argv);
  // Force exit to avoid seekdb native library segfault on cleanup
  // (seekdb has a bug where its native cleanup crashes on process exit)
  process.exit(0);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ebrain] ${message}`);
  process.exit(1);
});
