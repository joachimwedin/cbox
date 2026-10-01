import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { TempDirs } from "./tempDirs.js";

const FIXTURE_PATH = fileURLToPath(new URL("../sbx/fixtures/fake-sbx.mjs", import.meta.url));

export type FakeSandbox = { name: string; agent: string; workspaces: string[] };

/**
 * Puts a fake `sbx` binary (test/sbx/fixtures/fake-sbx.mjs) at the front of
 * PATH for the duration of a test, since no real `sbx` is available outside
 * a real sandbox host. `envOverrides` become env vars the fake reads (e.g.
 * `FAKE_SBX_EXIT_RUN`) -- see the fixture's own header comment for the full
 * set, except `FAKE_SBX_SANDBOXES`: that one seeds the fake's sandbox list
 * (a JSON array of `{name, agent, workspaces}`) instead of being passed
 * through verbatim, since the fixture tracks that list in a state file
 * rather than rereading an env var. Call `teardown()` once per test, in
 * `afterEach`. Constructing a second instance before the first's
 * `teardown()` has run is a bug (both would fight over `process.env.PATH`)
 * and throws rather than silently clobbering it.
 */
export class FakeSbx {
  private static active = false;

  private readonly tempDirs = new TempDirs();
  private readonly binDir: string;
  private readonly stateDir: string;
  private readonly logPath: string;
  private readonly cpMirrorDir: string;
  private readonly sandboxesPath: string;
  private readonly originalPath: string | undefined;
  private readonly envOverrideKeys: string[];

  constructor(envOverrides: Record<string, string> = {}) {
    if (FakeSbx.active) {
      throw new Error(
        "FakeSbx: a previous instance is still active -- call its teardown() before constructing another",
      );
    }
    FakeSbx.active = true;

    this.binDir = this.tempDirs.make("cbox-fakesbx-bin-");
    const shimPath = path.join(this.binDir, "sbx");
    fs.writeFileSync(shimPath, `#!/usr/bin/env bash\nexec node "${FIXTURE_PATH}" "$@"\n`);
    fs.chmodSync(shimPath, 0o755);

    this.stateDir = this.tempDirs.make("cbox-fakesbx-state-");
    this.logPath = path.join(this.stateDir, "calls.jsonl");
    this.cpMirrorDir = path.join(this.stateDir, "cp-mirror");
    fs.mkdirSync(this.cpMirrorDir);

    const { FAKE_SBX_SANDBOXES, ...rest } = envOverrides;
    this.sandboxesPath = path.join(this.stateDir, "sandboxes.json");
    fs.writeFileSync(this.sandboxesPath, FAKE_SBX_SANDBOXES ?? "[]");

    this.originalPath = process.env.PATH;
    process.env.PATH = `${this.binDir}${path.delimiter}${this.originalPath}`;
    process.env.FAKE_SBX_LOG = this.logPath;
    process.env.FAKE_SBX_CP_MIRROR = this.cpMirrorDir;
    process.env.FAKE_SBX_SANDBOXES_FILE = this.sandboxesPath;
    this.envOverrideKeys = Object.keys(rest);
    for (const [key, value] of Object.entries(rest)) {
      process.env[key] = value;
    }
  }

  /** Every `sbx` invocation recorded so far, as argv arrays, in call order. */
  readLog(): string[][] {
    if (!fs.existsSync(this.logPath)) {
      return [];
    }
    return fs
      .readFileSync(this.logPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as string[]);
  }

  /** The fake's current sandbox list, including any `create` calls made so far. */
  sandboxes(): FakeSandbox[] {
    return JSON.parse(fs.readFileSync(this.sandboxesPath, "utf8"));
  }

  /** Where `cp`'s local file landed for a given `<name>:<remotePath>` target, once copied. */
  cpMirrorPath(remotePath: string): string {
    return path.join(this.cpMirrorDir, remotePath.replaceAll("/", "__"));
  }

  /** Restores PATH and removes the fixture's temp dirs. Call once per test, in `afterEach`. */
  teardown(): void {
    process.env.PATH = this.originalPath;
    delete process.env.FAKE_SBX_LOG;
    delete process.env.FAKE_SBX_CP_MIRROR;
    delete process.env.FAKE_SBX_SANDBOXES_FILE;
    for (const key of this.envOverrideKeys) {
      delete process.env[key];
    }
    this.tempDirs.cleanup();
    FakeSbx.active = false;
  }
}
