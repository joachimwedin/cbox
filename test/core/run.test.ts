import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listRegisteredSandboxes, recordSandbox } from "../../src/core/registry.js";
import { PROJECTS_SYNC_COMMAND, refreshCbox, runCbox } from "../../src/core/run.js";
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

    // the freshly-created sandbox is recorded so a later global `cbox refresh` knows about it
    expect(listRegisteredSandboxes(home)).toEqual([{ workdir, name: sandboxName }]);
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

    // reusing an existing sandbox still (re)registers it, backfilling sandboxes created before the registry existed
    expect(listRegisteredSandboxes(home)).toEqual([{ workdir, name: sandboxName }]);
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

describe("refreshCbox", () => {
  describe("default (just this directory's sandbox)", () => {
    it("Given no sandbox mounting workdir When refreshing Then it throws without touching sbx beyond the lookup", async () => {
      // Given
      const workdir = tempDirs.make("cbox-refresh-workdir-");
      const home = makeHome();
      const cboxRoot = makeCboxRoot();
      fake = new FakeSbx();

      // When / Then
      await expect(refreshCbox({ workdir, homedir: home, env: {}, cboxRoot })).rejects.toThrow(
        `no sandbox is mounting ${workdir}`,
      );
      expect(fake.readLog()).toEqual([["ls", "--json"]]);
    });

    it("Given an existing sandbox and a config with resolveAllowedHosts/resolveSettings When refreshing Then hosts are allowed, settings are written with the sync hook appended, and skills are copied -- without creating, running, or needing a prior registry entry", async () => {
      // Given
      const workdir = tempDirs.make("cbox-refresh-workdir-");
      const home = makeHome();
      const sandboxName = "cbox-existing";
      const configDir = tempDirs.make("cbox-refresh-config-");
      const configPath = path.join(configDir, "cbox.config.ts");
      fs.writeFileSync(
        configPath,
        [
          `import { record } from "${CALL_LOG_PATH}";`,
          "export default {",
          "  resolveAllowedHosts(ctx) {",
          '    record("resolveAllowedHosts");',
          '    return ["api.example.com"];',
          "  },",
          "  resolveSettings(ctx) {",
          '    record("resolveSettings");',
          "    return { replaced: true };",
          "  },",
          '  preCreate(ctx) { record("preCreate"); },',
          '  postCreate(ctx) { record("postCreate"); },',
          "};",
        ].join("\n"),
      );
      const cboxRoot = makeCboxRoot();
      fake = new FakeSbx({
        FAKE_SBX_SANDBOXES: JSON.stringify([{ name: sandboxName, agent: "claude", workspaces: [workdir] }]),
      });

      // When -- note: no recordSandbox call first; the default path resolves via sbx ls, not the registry
      const exitCode = await refreshCbox({ workdir, homedir: home, env: { CBOX_CONFIG: configPath }, cboxRoot });

      // Then
      expect(exitCode).toBe(0);
      expect(recorded()).toEqual(["resolveAllowedHosts", "resolveSettings"]);

      const log = fake.readLog();
      expect(log.some((call) => call[0] === "create")).toBe(false);
      expect(log.some((call) => call[0] === "run")).toBe(false);

      expect(log).toContainEqual(["policy", "allow", "network", "--sandbox", sandboxName, "api.example.com"]);

      const writtenSettings = fake.cpMirrorPath("/home/agent/.claude/settings.json");
      expect(JSON.parse(fs.readFileSync(writtenSettings, "utf8"))).toEqual({
        replaced: true,
        hooks: { Stop: [{ hooks: [{ type: "command", command: PROJECTS_SYNC_COMMAND }] }] },
      });

      expect(log.some((call) => call[0] === "cp" && call.includes(`${sandboxName}:/home/agent/.claude/skills/`))).toBe(
        true,
      );
    });

    it("Given no resolveAllowedHosts hook When refreshing Then no policy call is made at all", async () => {
      // Given
      const workdir = tempDirs.make("cbox-refresh-workdir-");
      const home = makeHome();
      const sandboxName = "cbox-existing";
      const cboxRoot = makeCboxRoot();
      fake = new FakeSbx({
        FAKE_SBX_SANDBOXES: JSON.stringify([{ name: sandboxName, agent: "claude", workspaces: [workdir] }]),
      });

      // When
      const exitCode = await refreshCbox({ workdir, homedir: home, env: {}, cboxRoot });

      // Then
      expect(exitCode).toBe(0);
      expect(fake.readLog().some((call) => call[0] === "policy")).toBe(false);
    });
  });

  describe("--all", () => {
    it("Given two registered, live sandboxes and a config with resolveAllowedHosts/resolveSettings When refreshing with --all Then both are refreshed using each one's own workdir in ctx, and skills are copied for each -- without creating or running anything", async () => {
      // Given
      const workdirA = tempDirs.make("cbox-refresh-workdir-a-");
      const workdirB = tempDirs.make("cbox-refresh-workdir-b-");
      const home = makeHome();
      const nameA = "cbox-a";
      const nameB = "cbox-b";
      const configDir = tempDirs.make("cbox-refresh-config-");
      const configPath = path.join(configDir, "cbox.config.ts");
      fs.writeFileSync(
        configPath,
        [
          "export default {",
          "  resolveAllowedHosts(ctx) {",
          `    return ctx.workdir === ${JSON.stringify(workdirA)} ? ["api.example.com"] : ["other.example.com"];`,
          "  },",
          "  resolveSettings(ctx) {",
          "    return { forWorkdir: ctx.workdir };",
          "  },",
          "};",
        ].join("\n"),
      );
      const cboxRoot = makeCboxRoot();
      fake = new FakeSbx({
        FAKE_SBX_SANDBOXES: JSON.stringify([
          { name: nameA, agent: "claude", workspaces: [workdirA] },
          { name: nameB, agent: "claude", workspaces: [workdirB] },
        ]),
      });
      recordSandbox(home, workdirA, nameA);
      recordSandbox(home, workdirB, nameB);

      // When
      const exitCode = await refreshCbox(
        { workdir: workdirA, homedir: home, env: { CBOX_CONFIG: configPath }, cboxRoot },
        true,
      );

      // Then
      expect(exitCode).toBe(0);
      const log = fake.readLog();
      expect(log.some((call) => call[0] === "create")).toBe(false);
      expect(log.some((call) => call[0] === "run")).toBe(false);

      expect(log).toContainEqual(["policy", "allow", "network", "--sandbox", nameA, "api.example.com"]);
      expect(log).toContainEqual(["policy", "allow", "network", "--sandbox", nameB, "other.example.com"]);
      expect(log.some((call) => call[0] === "cp" && call.includes(`${nameA}:/home/agent/.claude/skills/`))).toBe(true);
      expect(log.some((call) => call[0] === "cp" && call.includes(`${nameB}:/home/agent/.claude/skills/`))).toBe(true);

      expect(JSON.parse(fs.readFileSync(fake.cpMirrorPath("/home/agent/.claude/settings.json"), "utf8"))).toBeTruthy();
    });

    it("Given a registered sandbox that sbx no longer reports When refreshing with --all Then it's skipped without failing, and stays registered for next time", async () => {
      // Given
      const workdir = tempDirs.make("cbox-refresh-workdir-");
      const home = makeHome();
      const cboxRoot = makeCboxRoot();
      fake = new FakeSbx(); // sbx reports no sandboxes at all
      recordSandbox(home, workdir, "cbox-gone");

      // When
      const exitCode = await refreshCbox({ workdir, homedir: home, env: {}, cboxRoot }, true);

      // Then
      expect(exitCode).toBe(0);
      expect(fake.readLog().some((call) => call[0] === "cp" || call[0] === "policy")).toBe(false);
      // not pruned -- it stays registered in case the sandbox comes back
      expect(listRegisteredSandboxes(home)).toEqual([{ workdir, name: "cbox-gone" }]);
    });

    it("Given one sandbox's refresh step fails When refreshing with --all Then the other is still refreshed and the exit code is non-zero", async () => {
      // Given
      const workdirA = tempDirs.make("cbox-refresh-workdir-a-");
      const workdirB = tempDirs.make("cbox-refresh-workdir-b-");
      const home = makeHome();
      const nameA = "cbox-a";
      const nameB = "cbox-b";
      const configDir = tempDirs.make("cbox-refresh-config-");
      const configPath = path.join(configDir, "cbox.config.ts");
      fs.writeFileSync(
        configPath,
        [
          "export default {",
          "  resolveAllowedHosts(ctx) {",
          `    return ctx.workdir === ${JSON.stringify(workdirA)} ? ["api.example.com"] : [];`,
          "  },",
          "};",
        ].join("\n"),
      );
      const cboxRoot = makeCboxRoot();
      fake = new FakeSbx({
        FAKE_SBX_SANDBOXES: JSON.stringify([
          { name: nameA, agent: "claude", workspaces: [workdirA] },
          { name: nameB, agent: "claude", workspaces: [workdirB] },
        ]),
        FAKE_SBX_EXIT_POLICY: "1", // makes sbx's own `policy allow network` call fail
      });
      recordSandbox(home, workdirA, nameA);
      recordSandbox(home, workdirB, nameB);

      // When
      const exitCode = await refreshCbox(
        { workdir: workdirA, homedir: home, env: { CBOX_CONFIG: configPath }, cboxRoot },
        true,
      );

      // Then -- A has hosts to allow and that sbx call fails; B has none, so it only writes settings/skills and succeeds
      expect(exitCode).toBe(1);
      expect(
        fake.readLog().some((call) => call[0] === "cp" && call.includes(`${nameB}:/home/agent/.claude/skills/`)),
      ).toBe(true);
    });
  });
});
