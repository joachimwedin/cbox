import { afterEach, describe, expect, it } from "vitest";

import { listRegisteredSandboxes, recordSandbox } from "../../src/core/registry.js";
import { TempDirs } from "../support/tempDirs.js";

const tempDirs = new TempDirs();

afterEach(() => {
  tempDirs.cleanup();
});

function makeHome(): string {
  return tempDirs.make("cbox-registry-home-");
}

describe("recordSandbox / listRegisteredSandboxes", () => {
  it("Given no prior registry When recording a sandbox Then it comes back as registered", () => {
    // Given
    const home = makeHome();

    // When
    recordSandbox(home, "/work/a", "cbox-a");

    // Then
    expect(listRegisteredSandboxes(home)).toEqual([{ workdir: "/work/a", name: "cbox-a" }]);
  });

  it("Given a second recording for the same workdir When recording Then it replaces the earlier entry instead of appending", () => {
    // Given
    const home = makeHome();
    recordSandbox(home, "/work/a", "cbox-old");

    // When
    recordSandbox(home, "/work/a", "cbox-new");

    // Then
    expect(listRegisteredSandboxes(home)).toEqual([{ workdir: "/work/a", name: "cbox-new" }]);
  });

  it("Given two registered sandboxes When listing Then both come back, regardless of whether either is actually still live", () => {
    // Given
    const home = makeHome();
    recordSandbox(home, "/work/a", "cbox-a");
    recordSandbox(home, "/work/b", "cbox-b");

    // When
    const entries = listRegisteredSandboxes(home);

    // Then -- listing never prunes; it's purely a read of what's on disk
    expect(entries).toEqual([
      { workdir: "/work/a", name: "cbox-a" },
      { workdir: "/work/b", name: "cbox-b" },
    ]);
  });
});
