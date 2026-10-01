import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, resolveConfigPath } from "../../src/core/config.js";
import { TempDirs } from "../support/tempDirs.js";

describe("resolveConfigPath", () => {
  it("Given CBOX_CONFIG is set When resolving the config path Then it's used as-is, marked explicit", () => {
    // Given
    const env = { CBOX_CONFIG: "/wherever/cbox.config.ts" };

    // When
    const resolved = resolveConfigPath(env, "/cbox-root");

    // Then
    expect(resolved).toEqual({ path: "/wherever/cbox.config.ts", explicit: true });
  });

  it("Given CBOX_CONFIG is an empty string When resolving the config path Then it falls back to cboxRoot, same as if unset", () => {
    // Given
    const env = { CBOX_CONFIG: "" };

    // When
    const resolved = resolveConfigPath(env, "/cbox-root");

    // Then
    expect(resolved).toEqual({ path: "/cbox-root/cbox.config.ts", explicit: false });
  });

  it("Given CBOX_CONFIG isn't set When resolving the config path Then it defaults to cboxRoot/cbox.config.ts, marked not explicit", () => {
    // Given
    const env = {};

    // When
    const resolved = resolveConfigPath(env, "/cbox-root");

    // Then
    expect(resolved).toEqual({ path: "/cbox-root/cbox.config.ts", explicit: false });
  });
});

describe("loadConfig", () => {
  const tempDirs = new TempDirs();
  afterEach(() => {
    tempDirs.cleanup();
  });

  it("Given no cbox.config.ts at the cbox-root default When loading the config Then it returns an empty config rather than erroring", async () => {
    // Given
    const cboxRoot = tempDirs.make("cbox-root-");
    const env = {};

    // When
    const config = await loadConfig(env, cboxRoot);

    // Then
    expect(config).toEqual({});
  });

  it("Given CBOX_CONFIG points at a file that doesn't exist When loading the config Then it throws, since the explicit path was wrong", async () => {
    // Given
    const env = { CBOX_CONFIG: "/no/such/cbox.config.ts" };

    // When
    const result = loadConfig(env, "/cbox-root");

    // Then
    await expect(result).rejects.toThrow(/\/no\/such\/cbox\.config\.ts/);
  });

  it("Given a real cbox.config.ts exporting hooks via defineConfig When loading the config Then the hooks it defines come back intact", async () => {
    // Given
    const home = tempDirs.make("cbox-config-");
    const configPath = path.join(home, "cbox.config.ts");
    fs.writeFileSync(
      configPath,
      ["export default {", "  resolveEnv(ctx) {", '    return { MARKER: "loaded" };', "  },", "};"].join("\n"),
    );
    const env = { CBOX_CONFIG: configPath };

    // When
    const config = await loadConfig(env, "/cbox-root");

    // Then
    expect(config.resolveEnv).toBeTypeOf("function");
    expect(config.resolveEnv?.({ workdir: "", homedir: "" })).toEqual({
      MARKER: "loaded",
    });
  });

  it("Given a real cbox.config.ts sitting at the cbox-root default When loading the config Then it's picked up without CBOX_CONFIG being set", async () => {
    // Given
    const cboxRoot = tempDirs.make("cbox-root-");
    fs.writeFileSync(
      path.join(cboxRoot, "cbox.config.ts"),
      ["export default {", "  resolveEnv(ctx) {", '    return { MARKER: "from-root" };', "  },", "};"].join("\n"),
    );
    const env = {};

    // When
    const config = await loadConfig(env, cboxRoot);

    // Then
    expect(config.resolveEnv?.({ workdir: "", homedir: "" })).toEqual({ MARKER: "from-root" });
  });
});
