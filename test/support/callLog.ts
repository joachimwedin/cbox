/**
 * Shared call-order log. A `cbox.config.ts` fixture loaded by absolute path
 * can `record` into it from inside a hook, and -- since the dynamic import
 * runs in this same process -- a test importing this same module can
 * `reset` it beforehand and read it back with `recorded` to assert
 * invocation order.
 */
let calls: string[] = [];

export function record(step: string): void {
  calls.push(step);
}

export function reset(): void {
  calls = [];
}

export function recorded(): string[] {
  return [...calls];
}
