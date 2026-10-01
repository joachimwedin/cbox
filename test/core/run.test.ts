import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PROJECTS_SYNC_COMMAND, runCbox } from "../../src/core/run.js";
import { recorded, reset } from "../support/callLog.js";
import { FakeSbx } from "../support/fakeSbx.js";
import { TempDirs } from "../support/tempDirs.js";

const CALL_LOG_PATH = fileURLToPath(new URL("../support/callLog.ts", import.meta.url));

let fake: FakeSbx | undefined;
const tempDirs = new TempDirs();

beforeEach(() => {
  reset();
});

afterEach(() => {
  fake?.teardown();
  fake = undefined;
  tempDirs.cleanup();
});

function makeHome(): string {
  const home = tempDirs.make("cbox-run-home-");
  fs.mkdirSync(path.join(home, ".claude", "skills", "a-skill"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "skills", "a-skill", "SKILL.md"), "a");
  return home;
}

// Empty on purpose: these tests set CBOX_CONFIG explicitly or not at all, never relying on a cbox.config.ts actually
// sitting at the root default.
function makeCboxRoot(): string {
  return tempDirs.make("cbox-run-cboxroot-");
}

describe("runCbox", () => {
  it("Given no config and no existing sandbox When run Then it creates the sandbox with the fixed defaults, writes the host's settings with the sync hook appended (preserving an existing Stop hook), copies skills, and runs it", async () => {
    // Given
    const workdir = tempDirs.make("cbox-run-workdir-");
    const home = makeHome();
    fs.writeFileSync(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({
        marker: "host-settings",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "echo existing" }] }] },
      }),
    );
    const cboxRoot = makeCboxRoot();
    fake = new FakeSbx();

    // When
    const exitCode = await runCbox(["extra-arg"], { workdir, homedir: home, env: {}, cboxRoot });

    // Then
    expect(exitCode).toBe(0);
    const log = fake.readLog();
    expect(log[0]).toEqual(["ls", "--json"]);
    expect(log[1]).toEqual([
      "create",
      "claude",
      "-e",
      `HOST_HOME=${home}`,
      workdir,
      path.join(home, ".claude", "projects"),
    ]);
    expect(log[2]).toEqual(["ls", "--json"]);

    const sandboxName = fake.sandboxes().at(-1)?.name;
    expect(sandboxName).toBeDefined();

    // no resolveAllowedHosts hook means no hosts, so no sbx policy call at all -- never invoke it with nothing to allow
    expect(log.some((call) => call[0] === "policy")).toBe(false);

    expect(log[3][0]).toBe("cp");
    expect(log.some((call) => call[0] === "cp" && call.includes(`${sandboxName}:/home/agent/.claude/skills/`))).toBe(
      true,
    );
    expect(log.at(-1)).toEqual(["run", "--name", sandboxName, "--", "--dangerously-skip-permissions", "extra-arg"]);

    const writtenSettings = fake.cpMirrorPath("/home/agent/.claude/settings.json");
    expect(JSON.parse(fs.readFileSync(writtenSettings, "utf8"))).toEqual({
      marker: "host-settings",
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "echo existing" }] },
          { hooks: [{ type: "command", command: PROJECTS_SYNC_COMMAND }] },
        ],
      },
    });

    // core's own fixed mount/dir prep, done regardless of any hook
    expect(fs.existsSync(path.join(home, ".claude", "projects"))).toBe(true);
  });

  it("Given a config with all six hooks When creating a new sandbox Then resolveEnv/resolveMounts/resolveSettings/resolveAllowedHosts fully replace core's own fixed fallbacks, and preCreate/postCreate both run around the fixed core steps", async () => {
    // Given
    const workdir = tempDirs.make("cbox-run-workdir-");
    const home = makeHome();
    const configDir = tempDirs.make("cbox-run-config-");
    const configPath = path.join(configDir, "cbox.config.ts");
    fs.writeFileSync(
      configPath,
      [
        `import { record } from "${CALL_LOG_PATH}";`,
        "export default {",
        "  resolveEnv(ctx) {",
        '    record("resolveEnv");',
        '    return { REPLACED: "yes" };',
        "  },",
        "  resolveMounts(ctx) {",
        '    record("resolveMounts");',
        '    return ["/only/this/mount"];',
        "  },",
        "  resolveSettings(ctx) {",
        '    record("resolveSettings");',
        '    return { replaced: true, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo existing" }] }] } };',
        "  },",
        "  resolveAllowedHosts(ctx) {",
        '    record("resolveAllowedHosts");',
        '    return ["api.example.com", "*.npmjs.org"];',
        "  },",
        "  preCreate(ctx) {",
        '    record("preCreate");',
        "  },",
        "  postCreate(ctx) {",
        '    record("postCreate");',
        '    ctx.sbx.exec(["exec", "marker-from-postCreate"]);',
        "  },",
        "};",
      ].join("\n"),
    );
    const cboxRoot = makeCboxRoot();
    fake = new FakeSbx();

    // When
    await runCbox([], { workdir, homedir: home, env: { CBOX_CONFIG: configPath }, cboxRoot });

    // Then
    expect(recorded()).toEqual([
      "resolveEnv",
      "resolveMounts",
      "resolveSettings",
      "resolveAllowedHosts",
      "preCreate",
      "postCreate",
    ]);

    const log = fake.readLog();
    const createCall = log.find((call) => call[0] === "create");
    expect(createCall).toEqual([
      "create",
      "claude",
      "-e",
      "REPLACED=yes",
      "-e",
      `HOST_HOME=${home}`,
      workdir,
      path.join(home, ".claude", "projects"),
      "/only/this/mount",
    ]);

    const sandboxName = fake.sandboxes().at(-1)?.name;
    const allowNetworkCall = log.find((call) => call[0] === "policy");
    expect(allowNetworkCall).toEqual([
      "policy",
      "allow",
      "network",
      "--sandbox",
      sandboxName,
      "api.example.com,*.npmjs.org",
    ]);

    const writtenSettings = fake.cpMirrorPath("/home/agent/.claude/settings.json");
    expect(JSON.parse(fs.readFileSync(writtenSettings, "utf8"))).toEqual({
      replaced: true,
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "echo existing" }] },
          { hooks: [{ type: "command", command: PROJECTS_SYNC_COMMAND }] },
        ],
      },
    });

    const allowNetworkCallIndex = log.findIndex((call) => call[0] === "policy");
    const postCreateCallIndex = log.findIndex((call) => call[0] === "exec" && call[1] === "marker-from-postCreate");
    const writeSettingsCallIndex = log.findIndex(
      (call) => call[0] === "cp" && call.some((arg) => arg.endsWith(":/home/agent/.claude/settings.json")),
    );
    // the allowed hosts land before postCreate runs, so a postCreate step can rely on them being reachable.
    expect(allowNetworkCallIndex).toBeGreaterThanOrEqual(0);
    expect(allowNetworkCallIndex).toBeLessThan(postCreateCallIndex);
    // postCreate runs before the settings write, so a hook gets a chance to act before cbox's own settings land.
    expect(postCreateCallIndex).toBeLessThan(writeSettingsCallIndex);
  });

  it("Given a config with hooks and a sandbox that already exists When run Then no hook runs, but skills are still copied and the sandbox is still run", async () => {
    // Given
    const workdir = tempDirs.make("cbox-run-workdir-");
    const home = makeHome();
    const sandboxName = "cbox-existing";
    const configDir = tempDirs.make("cbox-run-config-");
    const configPath = path.join(configDir, "cbox.config.ts");
    fs.writeFileSync(
      configPath,
      [
        "export default {",
        '  preCreate(ctx) { record("preCreate"); },',
        '  postCreate(ctx) { record("postCreate"); },',
        "};",
      ].join("\n"),
    );
    const cboxRoot = makeCboxRoot();
    fake = new FakeSbx({
      FAKE_SBX_SANDBOXES: JSON.stringify([{ name: sandboxName, agent: "claude", workspaces: [workdir] }]),
    });

    // When
    const exitCode = await runCbox([], { workdir, homedir: home, env: { CBOX_CONFIG: configPath }, cboxRoot });

    // Then
    expect(exitCode).toBe(0);
    expect(recorded()).toEqual([]);
    const log = fake.readLog();
    expect(log[0]).toEqual(["ls", "--json"]);
    expect(log.some((call) => call[0] === "create")).toBe(false);
    expect(log.some((call) => call[0] === "cp" && call.includes(`${sandboxName}:/home/agent/.claude/skills/`))).toBe(
      true,
    );
    expect(log.at(-1)?.[0]).toBe("run");
  });

  it("Given the sandboxed session exits non-zero When run Then that exit code is propagated", async () => {
    // Given
    const workdir = tempDirs.make("cbox-run-workdir-");
    const home = makeHome();
    const sandboxName = "cbox-existing";
    const cboxRoot = makeCboxRoot();
    fake = new FakeSbx({
      FAKE_SBX_SANDBOXES: JSON.stringify([{ name: sandboxName, agent: "claude", workspaces: [workdir] }]),
      FAKE_SBX_EXIT_RUN: "7",
    });

    // When
    const exitCode = await runCbox([], { workdir, homedir: home, env: {}, cboxRoot });

    // Then
    expect(exitCode).toBe(7);
  });
});
