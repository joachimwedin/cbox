import * as fs from "node:fs";
import * as path from "node:path";

import type { CboxConfig, Ctx } from "../hooks/types.js";
import { createSandbox, findSandboxByWorkdir, listSandboxes, SbxClient } from "../sbxClient.js";
import { type Env, loadConfig } from "./config.js";
import { listRegisteredSandboxes, type RegistryEntry, recordSandbox } from "./registry.js";

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

// Shared by the creation path and `refreshCbox` -- the one source of truth for how settings.json is built.
function resolveSettings(config: CboxConfig, ctx: Ctx, homedir: string): Record<string, unknown> {
  return withProjectsSyncHook(applyHook(config.resolveSettings, ctx, readHostSettings(homedir)));
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

    const settings = resolveSettings(config, ctx, homedir);

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
    recordSandbox(homedir, workdir, createdName);

    if (allowedHosts.length > 0) {
      sbx.allowNetwork(allowedHosts);
    }

    if (config.postCreate) {
      await config.postCreate({ ...ctx, sbx });
    }

    sbx.writeSettings(settings);
  } else {
    sbx = new SbxClient(existingName);
    // Backfills the registry for a sandbox that predates it, or was created by an older cbox build.
    recordSandbox(homedir, workdir, existingName);
  }

  sbx.copySkills(path.join(homedir, ".claude", "skills"));

  return sbx.run(argv);
}

// Applies resolveAllowedHosts/resolveSettings/skills to one already-existing sandbox -- refreshCbox's unit of work.
function refreshOne(config: CboxConfig, entry: RegistryEntry, homedir: string): void {
  const sbx = new SbxClient(entry.name);
  const ctx: Ctx = { workdir: entry.workdir, homedir };

  const allowedHosts = applyHook(config.resolveAllowedHosts, ctx, []);
  if (allowedHosts.length > 0) {
    sbx.allowNetwork(allowedHosts);
  }

  sbx.writeSettings(resolveSettings(config, ctx, homedir));
  sbx.copySkills(path.join(homedir, ".claude", "skills"));
}

/**
 * Re-applies `resolveAllowedHosts`, `resolveSettings`, and skills to the
 * sandbox already mounting `deps.workdir` -- the fix for
 * `resolveAllowedHosts`/`resolveSettings` otherwise only ever being
 * applied once, at creation, so editing either in `cbox.config.ts` has no
 * effect on a sandbox `runCbox` is just reusing. `resolveEnv`/
 * `resolveMounts` aren't re-applied here: both are fixed into the sandbox
 * at `sbx create` time and there's no way to change them on a live
 * sandbox short of recreating it. Throws if no sandbox is mounting
 * `deps.workdir` yet -- there's nothing to refresh.
 */
async function refreshOneForWorkdir(deps: RunCboxDeps): Promise<number> {
  const { workdir, homedir } = deps;
  const config = await loadConfig(deps.env, deps.cboxRoot);

  const name = findSandboxByWorkdir(workdir);
  if (name === undefined) {
    throw new Error(`no sandbox is mounting ${workdir} as its primary workspace -- run cbox first to create one`);
  }

  refreshOne(config, { workdir, name }, homedir);
  console.log(`refreshed ${name} (${workdir})`);
  return 0;
}

/**
 * Re-applies `resolveAllowedHosts`, `resolveSettings`, and skills to
 * every cbox-managed sandbox still live, per the registry `runCbox` keeps
 * at `~/.cbox/sandboxes.json` (consulted instead of guessing from
 * `sbx ls`'s `agent` field, which only says a sandbox runs the claude
 * image, not that cbox made it). A registered sandbox `sbx ls` no longer
 * reports is never silently dropped -- it's warned about and skipped, and
 * stays registered for the next refresh. One sandbox's failure doesn't
 * stop the rest -- each is reported on its own line, and the overall exit
 * code is non-zero if any of them failed.
 */
async function refreshAll(deps: RunCboxDeps): Promise<number> {
  const { homedir } = deps;
  const config = await loadConfig(deps.env, deps.cboxRoot);

  const liveNames = new Set(listSandboxes().map((sandbox) => sandbox.name));
  const registered = listRegisteredSandboxes(homedir);
  for (const entry of registered) {
    if (!liveNames.has(entry.name)) {
      console.warn(`cbox refresh: ${entry.name} (${entry.workdir}) is registered but no longer exists -- skipping`);
    }
  }
  const live = registered.filter((entry) => liveNames.has(entry.name));

  if (live.length === 0) {
    console.log("no cbox-managed sandboxes to refresh");
    return 0;
  }

  let exitCode = 0;
  for (const entry of live) {
    try {
      refreshOne(config, entry, homedir);
      console.log(`refreshed ${entry.name} (${entry.workdir})`);
    } catch (err) {
      exitCode = 1;
      console.error(
        `failed to refresh ${entry.name} (${entry.workdir}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return exitCode;
}

/**
 * `cbox refresh`'s entry point: refreshes just `deps.workdir`'s own
 * sandbox by default, or every cbox-managed sandbox when `all` is true --
 * see `refreshOneForWorkdir`/`refreshAll` for each mode's own contract.
 */
export async function refreshCbox(deps: RunCboxDeps, all = false): Promise<number> {
  return all ? refreshAll(deps) : refreshOneForWorkdir(deps);
}
