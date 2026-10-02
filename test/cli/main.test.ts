import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// Spawns the real `cbox` shim; only paths not needing a real `sbx` on PATH are exercised here -- the rest is covered
// by core/run.test.ts's direct runCbox/refreshCbox tests, which control homedir instead of touching the real one.
const CLI_PATH = path.resolve(__dirname, "..", "..", "cbox");

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync(CLI_PATH, args, { encoding: "utf8" });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err) {
    const execErr = err as { stdout: string; stderr: string; status: number | null };
    return { stdout: execErr.stdout, stderr: execErr.stderr, exitCode: execErr.status ?? -1 };
  }
}

describe("cbox", () => {
  it("Given -h When invoking the CLI Then it prints usage and exits 0 without touching sbx", () => {
    // Given
    const args = ["-h"];

    // When
    const { stdout, exitCode } = runCli(args);

    // Then
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: cbox [args...]");
  });

  it("Given --help When invoking the CLI Then it prints usage and exits 0 without touching sbx", () => {
    // Given
    const args = ["--help"];

    // When
    const { stdout, exitCode } = runCli(args);

    // Then
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: cbox [args...]");
  });

  it("Given --help among other args When invoking the CLI Then it still prints usage and exits 0", () => {
    // Given
    const args = ["--resume", "abc123", "--help"];

    // When
    const { stdout, exitCode } = runCli(args);

    // Then
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: cbox [args...]");
  });

  it("Given refresh with an unrecognized argument shape When invoking the CLI Then it errors and exits 1 without touching sbx", () => {
    // Given
    const args = ["refresh", "extra"];

    // When
    const { stderr, exitCode } = runCli(args);

    // Then
    expect(exitCode).toBe(1);
    expect(stderr).toContain("usage: cbox refresh [--all]");
  });

  it("Given refresh --all with an extra argument When invoking the CLI Then it errors and exits 1 without touching sbx", () => {
    // Given
    const args = ["refresh", "--all", "extra"];

    // When
    const { stderr, exitCode } = runCli(args);

    // Then
    expect(exitCode).toBe(1);
    expect(stderr).toContain("usage: cbox refresh [--all]");
  });
});
