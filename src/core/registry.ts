import * as fs from "node:fs";
import * as path from "node:path";

/**
 * cbox's own record of which sandbox it created for which directory,
 * kept at `~/.cbox/sandboxes.json` -- the thing a global `cbox refresh`
 * consults instead of guessing from `sbx ls`'s `agent` field, which only
 * says a sandbox runs the claude image, not that cbox created it.
 */
export type RegistryEntry = { workdir: string; name: string };

function registryPath(homedir: string): string {
  return path.join(homedir, ".cbox", "sandboxes.json");
}

function readRegistry(homedir: string): RegistryEntry[] {
  const filePath = registryPath(homedir);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as RegistryEntry[];
}

function writeRegistry(homedir: string, entries: RegistryEntry[]): void {
  const filePath = registryPath(homedir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2));
}

/** Upserts `name` as the sandbox for `workdir`, keyed by `workdir` -- a later create/reuse for the same directory replaces it. */
export function recordSandbox(homedir: string, workdir: string, name: string): void {
  const entries = readRegistry(homedir).filter((entry) => entry.workdir !== workdir);
  entries.push({ workdir, name });
  writeRegistry(homedir, entries);
}

/**
 * Every sandbox cbox has ever recorded for `homedir`, live or not --
 * callers decide what to do with an entry whose sandbox no longer exists
 * (e.g. removed via `sbx rm` outside cbox). Never prunes: a sandbox that's
 * merely stopped, or temporarily missing from `sbx ls`, stays registered
 * rather than being silently forgotten.
 */
export function listRegisteredSandboxes(homedir: string): RegistryEntry[] {
  return readRegistry(homedir);
}
