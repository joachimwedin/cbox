import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// Spawns the real `cbox` shim; only the help path is exercised, since it's the only one not needing a real `sbx` on PATH.
const CLI_PATH = path.resolve(__dirname, "..", "..", "cbox");

function runCli(args: string[]): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync(CLI_PATH, args, { encoding: "utf8" });
    return { stdout, exitCode: 0 };
  } catch (err) {
    const execErr = err as { stdout: string; status: number | null };
    return { stdout: execErr.stdout, exitCode: execErr.status ?? -1 };
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
});
