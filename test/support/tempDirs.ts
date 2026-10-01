import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Creates self-cleaning temp directories for a test. Call `make` for each
 * one needed (auto-registered for cleanup), and `cleanup` once per test, in
 * `afterEach`.
 */
export class TempDirs {
  private readonly dirs: string[] = [];

  make(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    this.dirs.push(dir);
    return dir;
  }

  cleanup(): void {
    for (const dir of this.dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
