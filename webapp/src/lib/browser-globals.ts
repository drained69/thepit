/**
 * Browser shims near-api-js v1 still expects: `Buffer` and a defined
 * `global`. Imported FIRST in main.tsx, before any near/wallet modules.
 */
import { Buffer } from "buffer";

const g = globalThis as any;
if (!g.Buffer) g.Buffer = Buffer;
if (!g.global) g.global = globalThis;
if (!g.process) {
  g.process = { env: {}, version: "v0.0.0", browser: true, nextTick: (fn: any, ...a: any[]) => queueMicrotask(() => fn(...a)) };
}
export {};
