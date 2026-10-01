#!/usr/bin/env node
// Stand-in for the real `sbx` binary (not available outside a real sandbox
// host) -- put on PATH as a real subprocess so a test exercises actual
// subprocess invocation rather than TS-level mocking. Every invocation is
// appended as one JSON line to FAKE_SBX_LOG. The sandbox list lives in the
// JSON file at FAKE_SBX_SANDBOXES_FILE (an array of `{name, agent,
// workspaces}` entries) -- `ls --json` prints `{"sandboxes": <that file's
// contents>}`, and `create` (no --name, since cbox always lets sbx pick
// one) appends a freshly-named entry to it, with `workspaces` taken from
// its own non-`-e`-flag positional args, so a lookup made after `create`
// sees the sandbox it just made. `cp <local> <name:remote>` copies
// `local`'s bytes to
// `${FAKE_SBX_CP_MIRROR}/<remote with slashes replaced by __>`, so a test
// can read back what was copied after the source temp file is gone. Each
// subcommand's exit code is controlled by FAKE_SBX_EXIT_<SUBCOMMAND> (e.g.
// FAKE_SBX_EXIT_RUN=3). FAKE_SBX_SIGNAL_<SUBCOMMAND> (e.g.
// FAKE_SBX_SIGNAL_RUN=SIGTERM) self-delivers that signal instead, so a test
// can exercise a child killed by a signal rather than exiting on its own.
import * as fs from "node:fs";
import * as path from "node:path";

const argv = process.argv.slice(2);
const [subcommand, ...rest] = argv;

if (process.env.FAKE_SBX_LOG) {
  fs.appendFileSync(process.env.FAKE_SBX_LOG, `${JSON.stringify(argv)}\n`);
}

function readSandboxes(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
}

if (subcommand === "ls" && rest.includes("--json") && process.env.FAKE_SBX_SANDBOXES_FILE) {
  const sandboxes = readSandboxes(process.env.FAKE_SBX_SANDBOXES_FILE);
  process.stdout.write(`${JSON.stringify({ sandboxes })}\n`);
}

if (subcommand === "create" && process.env.FAKE_SBX_SANDBOXES_FILE) {
  const file = process.env.FAKE_SBX_SANDBOXES_FILE;
  const [, ...flagsAndMounts] = rest; // rest[0] is the agent image, fixed and irrelevant here
  const workspaces = [];
  for (let i = 0; i < flagsAndMounts.length; i++) {
    if (flagsAndMounts[i] === "-e") {
      i++; // skip the KEY=VALUE that follows
      continue;
    }
    workspaces.push(flagsAndMounts[i]);
  }
  const sandboxes = readSandboxes(file);
  sandboxes.push({ name: `cbox-created-${sandboxes.length}`, agent: "claude", workspaces });
  fs.writeFileSync(file, JSON.stringify(sandboxes));
}

if (subcommand === "cp" && process.env.FAKE_SBX_CP_MIRROR) {
  const nonFlagArgs = rest.filter((a) => !a.startsWith("-"));
  const [localPath, remoteSpec] = nonFlagArgs;
  const remotePath = remoteSpec.split(":")[1];
  const mirrorPath = path.join(process.env.FAKE_SBX_CP_MIRROR, remotePath.replaceAll("/", "__"));
  fs.cpSync(localPath, mirrorPath, { recursive: true });
}

const signalVar = `FAKE_SBX_SIGNAL_${(subcommand ?? "").toUpperCase()}`;
const signal = process.env[signalVar];
if (signal) {
  process.kill(process.pid, signal);
  // Block synchronously so the self-delivered signal's default disposition
  // (terminate the process) has a chance to land before any further JS
  // runs. If it somehow doesn't, that's a fixture bug -- fail loudly rather
  // than silently falling through to a normal exit.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  throw new Error(`fake-sbx: self-sent ${signal} but the process survived`);
}

const exitVar = `FAKE_SBX_EXIT_${(subcommand ?? "").toUpperCase()}`;
process.exit(Number(process.env[exitVar] ?? "0"));
