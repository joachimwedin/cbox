/** Facts gathered before any hook runs -- available to every hook. */
export type Ctx = {
  workdir: string;
  homedir: string;
};

/** `sbx` operations exposed to `postCreate`, so a hook never shells out to `sbx` by hand. */
export type SbxHelper = {
  /** Copies a local file/dir into the sandbox at `remotePath` (`sbx cp`). */
  cp(localPath: string, remotePath: string, opts?: { followSymlinks?: boolean }): void;
  /** Runs an arbitrary `sbx <args>` command against the sandbox. */
  exec(args: string[]): void;
};

/** `Ctx` plus the `sbx` helper -- passed to `postCreate`, which runs once the sandbox exists. */
export type HookCtx = Ctx & { sbx: SbxHelper };

export type ResolveEnvHook = (ctx: Ctx) => Record<string, string>;
/** Mounts beyond the sandbox's primary workspace and its projects-sync mount -- both are fixed by core and never passed through this hook. */
export type ResolveMountsHook = (ctx: Ctx) => string[];
export type ResolveSettingsHook = (ctx: Ctx) => Record<string, unknown>;
export type ResolveAllowedHostsHook = (ctx: Ctx) => string[];
export type PreCreateHook = (ctx: Ctx) => void | Promise<void>;
export type PostCreateHook = (ctx: HookCtx) => void | Promise<void>;

/**
 * The full v1 hook surface. `resolveEnv`/`resolveMounts`/`resolveSettings`/
 * `resolveAllowedHosts` are full-replace: whatever they return is final.
 * There's no `defaults` argument -- core's own fixed values (the primary
 * workspace mount, and the projects-sync mount/env var/Stop hook that
 * mirrors session history back to the host after every message) are never
 * routed through a hook in the first place, so build on anything else you
 * want (like the host's own `~/.claude/settings.json`) by reading it
 * yourself. `preCreate`/`postCreate` are additive: core's own fixed setup
 * always runs regardless. `preCreate` runs before the sandbox exists --
 * sbx itself picks its name, so there's nothing to bind an `sbx` helper to
 * yet; `postCreate` runs after, once one exists, and after
 * `resolveAllowedHosts`'s hosts have already been allowed, so a
 * `postCreate` step can rely on them being reachable. Every hook is
 * optional; an absent hook leaves core's own fixed behavior untouched. All
 * hooks only fire on the sandbox-creation path.
 */
export type CboxConfig = {
  resolveEnv?: ResolveEnvHook;
  resolveMounts?: ResolveMountsHook;
  resolveSettings?: ResolveSettingsHook;
  resolveAllowedHosts?: ResolveAllowedHostsHook;
  preCreate?: PreCreateHook;
  postCreate?: PostCreateHook;
};

/**
 * Identity helper for `cbox.config.ts`'s `export default defineConfig({...})`
 * -- gives the config object type-checking and editor completion.
 */
export function defineConfig(config: CboxConfig): CboxConfig {
  return config;
}
