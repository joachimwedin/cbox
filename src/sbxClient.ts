import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type CopyOptions = { followSymlinks?: boolean };

export type SandboxListEntry = { name: string; agent: string; workspaces: string[] };

/** Positional `sbx create` argument fixed since the original bash `cbox` alias -- not hookable. */
const CBOX_IMAGE = "claude";

/** Every sandbox `sbx` currently knows about, regardless of agent. */
export function listSandboxes(): SandboxListEntry[] {
  const output = execFileSync("sbx", ["ls", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const { sandboxes } = JSON.parse(output) as { sandboxes: SandboxListEntry[] };
  return sandboxes;
}

/**
 * Finds the sandbox (if any) already mounting `workdir` as its primary
 * workspace -- the first element of `workspaces`, not any secondary mount
 * -- so a sandbox that merely has `workdir` bind-mounted as an extra
 * workspace, or belongs to a different agent, is never mistaken for
 * cbox's own sandbox for that path.
 */
export function findSandboxByWorkdir(workdir: string): string | undefined {
  return listSandboxes().find((sandbox) => sandbox.agent === CBOX_IMAGE && sandbox.workspaces[0] === workdir)?.name;
}

/**
 * Creates a sandbox for the Claude agent, letting `sbx` pick its own name
 * -- find it afterward with `findSandboxByWorkdir` rather than cbox
 * inventing or guessing one.
 */
export function createSandbox(env: Record<string, string>, mounts: string[]): void {
  const envFlags = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  execFileSync("sbx", ["create", CBOX_IMAGE, ...envFlags, ...mounts], { stdio: "inherit" });
}

/**
 * The sole seam that invokes the `sbx` binary (see code-conventions.md's
 * TypeScript rules) -- every method makes at most one `sbx` subprocess
 * call: exactly one on a valid call, none if a precondition guard (e.g.
 * `allowNetwork`'s empty-hosts check) rejects it first. Bound to one
 * sandbox `name` at construction, except `exec`, a raw passthrough for
 * whatever argv a hook wants to run. Only ever constructed for a sandbox
 * that already exists -- see this file's `createSandbox`/
 * `findSandboxByWorkdir` for how that name is obtained.
 */
export class SbxClient {
  constructor(private readonly name: string) {}

  /**
   * Runs `sbx run` interactively, inheriting this process's stdio. Returns
   * the child's exit code rather than throwing on non-zero -- a non-zero
   * exit here is the interactive session's own outcome, not a cbox error.
   * `result.error` (e.g. ENOENT: `sbx` itself isn't on PATH) means the
   * process never ran at all, so it's rethrown rather than folded into a
   * generic exit code. `result.status === null` means the child was killed
   * by a signal rather than exiting on its own; that's reported with the
   * shell's own 128+signal convention instead of being collapsed into the
   * same exit code as an ordinary failure.
   */
  run(extraArgs: string[]): number {
    const argv = ["run", "--name", this.name, "--", "--dangerously-skip-permissions", ...extraArgs];
    const result = spawnSync("sbx", argv, { stdio: "inherit" });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== null) {
      return result.status;
    }
    if (result.signal === null) {
      throw new Error("sbx run: spawnSync reported neither an exit status nor a signal");
    }
    return 128 + os.constants.signals[result.signal];
  }

  cp(localPath: string, remotePath: string, opts: CopyOptions = {}): void {
    const args = ["cp", ...(opts.followSymlinks ? ["-L"] : []), localPath, `${this.name}:${remotePath}`];
    execFileSync("sbx", args, { stdio: ["ignore", "pipe", "pipe"] });
  }

  /** Runs an arbitrary `sbx <args>` command -- backs `ctx.sbx.exec` for `postCreate` hooks. */
  exec(args: string[]): void {
    execFileSync("sbx", args, { stdio: "inherit" });
  }

  /**
   * Scopes a `sbx policy allow network` rule to this sandbox. `hosts` must
   * be non-empty -- `sbx policy allow network` requires at least one
   * resource, so an empty list means the caller shouldn't have called
   * this at all.
   */
  allowNetwork(hosts: string[]): void {
    if (hosts.length === 0) {
      throw new Error("SbxClient.allowNetwork: hosts must be non-empty");
    }
    execFileSync("sbx", ["policy", "allow", "network", "--sandbox", this.name, hosts.join(",")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  /** Writes `settings` as JSON to the sandbox's `~/.claude/settings.json`. */
  writeSettings(settings: Record<string, unknown>): void {
    const tmpFile = path.join(os.tmpdir(), `cbox-settings-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(settings, null, 2));
    try {
      this.cp(tmpFile, "/home/agent/.claude/settings.json");
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  }

  /** Copies every entry directly under `skillsDir` into the sandbox's `~/.claude/skills/`, following symlinks. */
  copySkills(skillsDir: string): void {
    for (const entry of fs.readdirSync(skillsDir)) {
      this.cp(path.join(skillsDir, entry), "/home/agent/.claude/skills/", { followSymlinks: true });
    }
  }
}
