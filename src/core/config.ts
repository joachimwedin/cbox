import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import type { CboxConfig } from "../hooks/types.js";

export type Env = Record<string, string | undefined>;

export type ResolvedConfigPath = {
  path: string;
  /** True when the path came from an explicitly-set CBOX_CONFIG, rather than the cbox-root default. */
  explicit: boolean;
};

/** Pure: where `cbox.config.ts` should be -- `CBOX_CONFIG` verbatim when set and non-empty, otherwise `cboxRoot/cbox.config.ts`. */
export function resolveConfigPath(env: Env, cboxRoot: string): ResolvedConfigPath {
  if (env.CBOX_CONFIG !== undefined && env.CBOX_CONFIG !== "") {
    return { path: env.CBOX_CONFIG, explicit: true };
  }

  return { path: path.join(cboxRoot, "cbox.config.ts"), explicit: false };
}

/**
 * Loads `cbox.config.ts`'s default export. Returns `{}` (no hooks, every
 * default applies as-is) when the cbox-root default path doesn't exist --
 * a fresh clone with no config written yet is expected, not an error. An
 * explicitly-set `CBOX_CONFIG` that doesn't exist is a real
 * misconfiguration and throws.
 */
export async function loadConfig(env: Env, cboxRoot: string): Promise<CboxConfig> {
  const resolved = resolveConfigPath(env, cboxRoot);

  if (!fs.existsSync(resolved.path)) {
    if (resolved.explicit) {
      throw new Error(`CBOX_CONFIG points at a file that doesn't exist: ${resolved.path}`);
    }
    return {};
  }

  const loaded = (await import(pathToFileURL(resolved.path).href)) as { default?: CboxConfig };
  if (loaded.default === undefined) {
    throw new Error(`${resolved.path} has no default export (expected \`export default defineConfig({...})\`)`);
  }
  return loaded.default;
}
