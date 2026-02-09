// Typed deferred utility — own module to keep runtime code out of the type barrel (src/types.ts)
// Reusable in runEagerPipeline() and tests

import type { Deferred } from "../types.js";

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
