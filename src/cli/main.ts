import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { runCbox } from "../core/run.js";

/** The cbox install's own root -- two directories up from this file, `src/cli/main.ts`. */
const CBOX_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const HELP_TEXT = `Usage: cbox [args...]

Creates (or reuses) a sandbox mounting the current working directory as
its workspace, then runs
\`claude --dangerously-skip-permissions\` inside it. An existing sandbox
already mounting this directory is reused; otherwise a fresh one is
created. Any arguments given are forwarded to that session.

Options:
  -h, --help   Show this help and exit.

Environment:
  CBOX_CONFIG   Path to cbox.config.ts (defaults to cbox.config.ts in cbox's own install root).

See cbox.config.example.ts for the hook API used to customize env vars,
mounts, settings.json, and extra setup steps.
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const isHelpFlag = argv.includes("-h") || argv.includes("--help");
  if (isHelpFlag) {
    console.log(HELP_TEXT);
    return 0;
  }

  return runCbox(argv, { workdir: process.cwd(), homedir: os.homedir(), env: process.env, cboxRoot: CBOX_ROOT });
}

main().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
