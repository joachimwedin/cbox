import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createSandbox, findSandboxByWorkdir, SbxClient } from "../src/sbxClient.js";
import { FakeSbx } from "./support/fakeSbx.js";
import { TempDirs } from "./support/tempDirs.js";

let fake: FakeSbx | undefined;
const tempDirs = new TempDirs();

afterEach(() => {
  fake?.teardown();
  fake = undefined;
  tempDirs.cleanup();
});

function makeTempDir(): string {
  return tempDirs.make("cbox-client-");
}

describe("findSandboxByWorkdir", () => {
  it("Given a sandbox whose primary workspace matches When finding by workdir Then its name is returned", () => {
    // Given
    fake = new FakeSbx({
      FAKE_SBX_SANDBOXES: JSON.stringify([
        { name: "cbox-abc123", agent: "claude", workspaces: ["/work/myrepo", "/home/agent/.claude/projects"] },
      ]),
    });

    // When
    const name = findSandboxByWorkdir("/work/myrepo");

    // Then
    expect(name).toBe("cbox-abc123");
  });

  it("Given a sandbox that only has the path as a secondary workspace When finding by workdir Then it's not matched", () => {
    // Given
    fake = new FakeSbx({
      FAKE_SBX_SANDBOXES: JSON.stringify([
        { name: "cbox-other", agent: "claude", workspaces: ["/work/other-repo", "/work/myrepo"] },
      ]),
    });

    // When
    const name = findSandboxByWorkdir("/work/myrepo");

    // Then
    expect(name).toBeUndefined();
  });

  it("Given a sandbox for a different agent with the same primary workspace When finding by workdir Then it's not matched", () => {
    // Given
    fake = new FakeSbx({
      FAKE_SBX_SANDBOXES: JSON.stringify([{ name: "cbox-codex", agent: "codex", workspaces: ["/work/myrepo"] }]),
    });

    // When
    const name = findSandboxByWorkdir("/work/myrepo");

    // Then
    expect(name).toBeUndefined();
  });

  it("Given no sandboxes exist When finding by workdir Then it returns undefined", () => {
    // Given
    fake = new FakeSbx();

    // When
    const name = findSandboxByWorkdir("/work/myrepo");

    // Then
    expect(name).toBeUndefined();
  });
});

describe("createSandbox", () => {
  it("Given no env vars and no mounts When creating a sandbox Then sbx is invoked with just the fixed image, no --name", () => {
    // Given
    fake = new FakeSbx();

    // When
    createSandbox({}, []);

    // Then
    expect(fake.readLog()).toEqual([["create", "claude"]]);
  });

  it("Given env and mounts When creating a sandbox Then sbx is invoked once with the matching create argv, no --name", () => {
    // Given
    fake = new FakeSbx();

    // When
    createSandbox({ FOO: "1" }, ["/work/myrepo"]);

    // Then
    expect(fake.readLog()).toEqual([["create", "claude", "-e", "FOO=1", "/work/myrepo"]]);
  });
});

describe("SbxClient.run", () => {
  it("Given the fake sbx exits 0 When running the sandbox Then the returned exit code is 0 and the run argv is logged", () => {
    // Given
    fake = new FakeSbx();
    const client = new SbxClient("cbox-myrepo");

    // When
    const exitCode = client.run(["--resume"]);

    // Then
    expect(exitCode).toBe(0);
    expect(fake.readLog()).toEqual([
      ["run", "--name", "cbox-myrepo", "--", "--dangerously-skip-permissions", "--resume"],
    ]);
  });

  it("Given the fake sbx exits non-zero When running the sandbox Then that exit code is returned rather than throwing", () => {
    // Given
    fake = new FakeSbx({ FAKE_SBX_EXIT_RUN: "3" });
    const client = new SbxClient("cbox-myrepo");

    // When
    const exitCode = client.run([]);

    // Then
    expect(exitCode).toBe(3);
  });

  it("Given the fake sbx is killed by a signal When running the sandbox Then the shell's 128+signal exit code is returned rather than a generic 1", () => {
    // Given
    fake = new FakeSbx({ FAKE_SBX_SIGNAL_RUN: "SIGTERM" });
    const client = new SbxClient("cbox-myrepo");

    // When
    const exitCode = client.run([]);

    // Then
    expect(exitCode).toBe(128 + os.constants.signals.SIGTERM);
  });

  it("Given sbx itself is not on PATH When running the sandbox Then the spawn failure is thrown rather than folded into an exit code", () => {
    // Given
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    const client = new SbxClient("cbox-myrepo");

    try {
      // When
      const run = () => client.run([]);

      // Then
      expect(run).toThrow();
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe("SbxClient.cp", () => {
  it("Given no options When copying a file into the sandbox Then sbx cp is invoked without the -L flag", () => {
    // Given
    fake = new FakeSbx();
    const client = new SbxClient("cbox-myrepo");
    const localFile = path.join(makeTempDir(), "f.txt");
    fs.writeFileSync(localFile, "hi");

    // When
    client.cp(localFile, "/home/agent/f.txt");

    // Then
    expect(fake.readLog()).toEqual([["cp", localFile, "cbox-myrepo:/home/agent/f.txt"]]);
  });

  it("Given followSymlinks is true When copying a file into the sandbox Then sbx cp is invoked with the -L flag", () => {
    // Given
    fake = new FakeSbx();
    const client = new SbxClient("cbox-myrepo");
    const localFile = path.join(makeTempDir(), "f.txt");
    fs.writeFileSync(localFile, "hi");

    // When
    client.cp(localFile, "/home/agent/f.txt", { followSymlinks: true });

    // Then
    expect(fake.readLog()).toEqual([["cp", "-L", localFile, "cbox-myrepo:/home/agent/f.txt"]]);
  });
});

describe("SbxClient.allowNetwork", () => {
  it("Given a list of hosts When allowing network access Then sbx policy allow network is scoped to this sandbox with the hosts comma-joined", () => {
    // Given
    fake = new FakeSbx();
    const client = new SbxClient("cbox-myrepo");

    // When
    client.allowNetwork(["api.example.com", "*.npmjs.org"]);

    // Then
    expect(fake.readLog()).toEqual([
      ["policy", "allow", "network", "--sandbox", "cbox-myrepo", "api.example.com,*.npmjs.org"],
    ]);
  });

  it("Given an empty hosts list When allowing network access Then it throws rather than invoking sbx with no resources", () => {
    // Given
    fake = new FakeSbx();
    const client = new SbxClient("cbox-myrepo");

    // When
    const call = () => client.allowNetwork([]);

    // Then
    expect(call).toThrow("non-empty");
    expect(fake.readLog()).toEqual([]);
  });
});

describe("SbxClient.exec", () => {
  it("Given an arbitrary argv When running it through exec Then sbx is invoked with exactly that argv", () => {
    // Given
    fake = new FakeSbx();
    const client = new SbxClient("cbox-myrepo");

    // When
    client.exec(["exec", "cbox-myrepo", "--", "echo", "hi"]);

    // Then
    expect(fake.readLog()).toEqual([["exec", "cbox-myrepo", "--", "echo", "hi"]]);
  });
});

describe("SbxClient.writeSettings", () => {
  it("Given a settings object When writing it to the sandbox Then its JSON contents land at the sandbox's settings.json path", () => {
    // Given
    fake = new FakeSbx();
    const client = new SbxClient("cbox-myrepo");
    const settings = { hooks: { Stop: [] } };

    // When
    client.writeSettings(settings);

    // Then
    const [call] = fake.readLog();
    expect(call[0]).toBe("cp");
    expect(call[2]).toBe("cbox-myrepo:/home/agent/.claude/settings.json");
    const mirrored = fake.cpMirrorPath("/home/agent/.claude/settings.json");
    expect(JSON.parse(fs.readFileSync(mirrored, "utf8"))).toEqual(settings);
  });
});

describe("SbxClient.copySkills", () => {
  it("Given a skills directory with two entries When copying skills to the sandbox Then each entry is copied with -L, in directory order", () => {
    // Given
    fake = new FakeSbx();
    const client = new SbxClient("cbox-myrepo");
    const skillsDir = makeTempDir();
    fs.writeFileSync(path.join(skillsDir, "a.md"), "a");
    fs.writeFileSync(path.join(skillsDir, "b.md"), "b");

    // When
    client.copySkills(skillsDir);

    // Then
    const calls = fake.readLog();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call[0]).toBe("cp");
      expect(call[1]).toBe("-L");
      expect(call[3]).toBe("cbox-myrepo:/home/agent/.claude/skills/");
    }
    const direntOrder = fs.readdirSync(skillsDir);
    expect(calls.map((call) => call[2])).toEqual(direntOrder.map((entry) => path.join(skillsDir, entry)));
  });
});
