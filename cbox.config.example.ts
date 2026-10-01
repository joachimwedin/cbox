/**
 * Copy this to cbox.config.ts (gitignored by default) and edit freely, or
 * point CBOX_CONFIG at your own copy living anywhere -- even in a different
 * repo you version-control separately. The `cbox` import below resolves
 * two ways: from inside this repo it resolves via Node's package
 * self-reference (no setup needed); from a separate repo, run `npm link
 * <path-to-this-repo>` there once so its `node_modules` has a `cbox` entry
 * to resolve against.
 *
 * resolveEnv/resolveMounts/resolveSettings/resolveAllowedHosts are
 * full-replace: whatever you return is final. There's no `defaults`
 * argument -- core's own fixed values (the primary workspace mount, and
 * the projects-sync mount/env var/Stop hook that mirrors session history
 * back to the host after every message) are never routed through a hook,
 * so read anything else you want to build on, like the host's own
 * ~/.claude/settings.json, yourself. preCreate/postCreate are additive:
 * cbox's own fixed setup (mount/dir prep, the settings copy, the skills
 * copy) always runs regardless of what they do. All six hooks only fire
 * when a sandbox is first created; reusing an existing one skips straight
 * to the skills copy and `sbx run`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  defineConfig,
  type PostCreateHook,
  type PreCreateHook,
  type ResolveAllowedHostsHook,
  type ResolveEnvHook,
  type ResolveMountsHook,
  type ResolveSettingsHook,
} from "cbox";

const resolveEnv: ResolveEnvHook = (ctx) => {
  return { PROJECT_NAME: path.basename(ctx.workdir) };
};

const resolveMounts: ResolveMountsHook = (ctx) => {
  return [path.join(ctx.homedir, "sandbox-files")];
};

// Extends the host's own settings.json instead of replacing it outright -- read it yourself, since there's no defaults argument.
const resolveSettings: ResolveSettingsHook = (ctx) => {
  const hostSettingsPath = path.join(ctx.homedir, ".claude", "settings.json");
  const hostSettings = fs.existsSync(hostSettingsPath)
    ? (JSON.parse(fs.readFileSync(hostSettingsPath, "utf8")) as Record<string, unknown>)
    : {};
  return { ...hostSettings, statusLine: { type: "command", command: "~/.claude/statusline-command.sh" } };
};

// Lets the sandbox reach npm's registry in addition to whatever sbx's own default policy already allows.
const resolveAllowedHosts: ResolveAllowedHostsHook = () => {
  return ["registry.npmjs.org"];
};

const preCreate: PreCreateHook = () => {};

// An ordinary postCreate step, like any other file a hook wants to seed into a fresh sandbox.
const postCreate: PostCreateHook = (ctx) => {
  ctx.sbx.cp(path.join(ctx.homedir, ".claude", "statusline-command.sh"), "/home/agent/.claude/statusline-command.sh");
};

export default defineConfig({
  resolveEnv,
  resolveMounts,
  resolveSettings,
  resolveAllowedHosts,
  preCreate,
  postCreate,
});
