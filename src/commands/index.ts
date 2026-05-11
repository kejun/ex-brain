import { readFileSync } from "node:fs";
import { Command } from "commander";
import { DEFAULT_DB_NAME } from "../slug-utils";
import { registerCompileCommands } from "./compile-cmd";
import { registerGraphCommand } from "./graph-cmd";
import { registerPutCommand } from "./put-cmd";
import { registerQueryCommand } from "./query-cmd";
import { registerImportCommand } from "./import-cmd";
import { registerTimelineCommand } from "./timeline-cmd";
import { registerTagCommand, registerRawCommand, registerLinkCommand } from "./misc-cmds";
import {
  registerExportCommand,
  registerEmbedCommand,
  registerInitCommand,
  registerStatsCommand,
  registerConfigCommand,
  registerServeCommand,
} from "./misc-commands";

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildProgram(): Command {
  const pkgPath = new URL("../../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const program = new Command("ebrain")
    .description("Personal knowledge base CLI powered by seekdb")
    .version(pkg.version, "-V, --version", "output the version number")
    .addHelpText(
      "after",
      `
Examples:
  ebrain config
  ebrain put docs/api --file api.md
  ebrain search "machine learning" --limit 5
  ebrain query "What projects did we ship in Q4?"
  cat note.md | ebrain put notes/daily --stdin
  ebrain serve   # start MCP server for AI tools
`,
    )
    .option("--db <path>", "database path (overrides settings.json)")
    .option("--json", "output as JSON", false);

  // Register commands
  registerConfigCommand(program);
  registerPutCommand(program);
  registerQueryCommand(program);
  registerLinkCommand(program);
  registerTimelineCommand(program);
  registerTagCommand(program);
  registerRawCommand(program);
  registerImportCommand(program);
  registerExportCommand(program);
  registerEmbedCommand(program);
  registerInitCommand(program);
  registerStatsCommand(program);
  registerServeCommand(program);

  // Register compile and smart-ingest commands
  registerCompileCommands(program);

  // Register graph command
  registerGraphCommand(program);

  // -- legacy aliases (backward compat) -------------------------------------
  program
    .command("tools")
    .description("alias for tools-json (deprecated)")
    .action(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { TOOL_MANIFEST } = require("../mcp/server");
      console.log(JSON.stringify({ tools: TOOL_MANIFEST }, null, 2));
    });

  return program;
}
