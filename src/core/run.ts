import * as fs from "node:fs";
import * as path from "node:path";

import type { Ctx } from "../hooks/types.js";
import { createSandbox, findSandboxByWorkdir, SbxClient } from "../sbxClient.js";
import { type Env, loadConfig } from "./config.js";

function readHostSettings(homedir: string): Record<string, unknown> {
  const settingsPath = path.join(homedir, ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
}

/** Relies on `HOST_HOME` (always set by core, see `runCbox`); swallows rsync failures rather than erroring. */
export const PROJECTS_SYNC_COMMAND =
  'rsync -a --update /home/agent/.claude/projects/ "$HOST_HOME/.claude/projects/" 2>/dev/null || true';

// Appends the projects-sync command to Stop, preserving whatever Stop hooks (and everything else) are already there.
function withProjectsSyncHook(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks =
    typeof settings.hooks === "object" && settings.hooks !== null ? (settings.hooks as Record<string, unknown>) : {};
  const stop = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  return {
    ...settings,
    hooks: { ...hooks, Stop: [...stop, { hooks: [{ type: "command", command: PROJECTS_SYNC_COMMAND }] }] },
  };
}

// Runs a full-replace hook when the config defines one, else keeps core's own fixed fallback.
function applyHook<T>(hook: ((ctx: Ctx) => T) | undefined, ctx: Ctx, fallback: T): T {
  return hook ? hook(ctx) : fallback;
}

export type RunCboxDeps = {
  workdir: string;
  homedir: string;
  env: Env;
  cboxRoot: string;
};

/**
 * cbox's whole per-invocation flow: a sandbox already mounting
 * `deps.workdir` as its primary workspace (see sbxClient.ts's
 * findSandboxByWorkdir) is reused as-is, skipping straight to the skills
 * copy and `sbx run`; otherwise a fresh one is created through the
 * config's hooks (full-replace over core's own fixed fallbacks) bracketed
 * by preCreate/postCreate, with `sbx` itself picking the new sandbox's
 * name. `workdir` and the projects-sync machinery -- the `~/.claude/
 * projects` mount, the `HOST_HOME` env var, and the settings Stop hook
 * that rsyncs transcripts back to the host after every message -- are all
 * fixed by core and never routed through a hook, so there's no hook input
 * that could break any of them. Any resolveAllowedHosts hosts are allowed
 * on the sandbox right after it's created, before postCreate runs, so a
 * postCreate step can rely on them being reachable. Returns the sandboxed
 * session's own exit code.
 */
export async function runCbox(argv: string[], deps: RunCboxDeps): Promise<number> {
  const { workdir, homedir } = deps;
  const claudeProjectsDir = path.join(homedir, ".claude", "projects");
  const config = await loadConfig(deps.env, deps.cboxRoot);

  const existingName = findSandboxByWorkdir(workdir);
  let sbx: SbxClient;

  if (existingName === undefined) {
    const ctx: Ctx = { workdir, homedir };

    const env = { ...applyHook(config.resolveEnv, ctx, {}), HOST_HOME: homedir };

    const extraMounts = applyHook(config.resolveMounts, ctx, []);
    const mounts = [workdir, claudeProjectsDir, ...extraMounts];

    const settings = withProjectsSyncHook(applyHook(config.resolveSettings, ctx, readHostSettings(homedir)));

    const allowedHosts = applyHook(config.resolveAllowedHosts, ctx, []);

    fs.mkdirSync(claudeProjectsDir, { recursive: true });

    if (config.preCreate) {
      await config.preCreate(ctx);
    }

    createSandbox(env, mounts);

    const createdName = findSandboxByWorkdir(workdir);
    if (createdName === undefined) {
      throw new Error(`sbx create succeeded but no sandbox is now mounting ${workdir} as its primary workspace`);
    }
    sbx = new SbxClient(createdName);

    if (allowedHosts.length > 0) {
      sbx.allowNetwork(allowedHosts);
    }

    if (config.postCreate) {
      await config.postCreate({ ...ctx, sbx });
    }

    sbx.writeSettings(settings);
  } else {
    sbx = new SbxClient(existingName);
  }

  sbx.copySkills(path.join(homedir, ".claude", "skills"));

  return sbx.run(argv);
}
