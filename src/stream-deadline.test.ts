import { test } from "node:test";
import assert from "node:assert/strict";
import { finalMessageWithDeadline } from "./stream-deadline.js";

/** Minimal fake of the SDK MessageStream surface the helper relies on. */
function fakeStream<T>(opts: {
  result?: Promise<T>;
  onAbort?: () => void;
}): { finalMessage(): Promise<T>; abort(): void } {
  return {
    finalMessage: () => opts.result ?? new Promise<T>(() => {}), // default: never settles
    abort: () => opts.onAbort?.(),
  };
}

test("resolves with the final message when it arrives before the deadline", async () => {
  const stream = fakeStream({ result: Promise.resolve("ok") });
  const result = await finalMessageWithDeadline(stream, 1000, "test");
  assert.equal(result, "ok");
});

test("rejects and aborts when finalMessage never settles past the deadline", async () => {
  let aborted = false;
  const stream = fakeStream<string>({ onAbort: () => (aborted = true) }); // never settles
  await assert.rejects(
    () => finalMessageWithDeadline(stream, 20, "extract"),
    /extract.*deadline|deadline.*extract|timed out/i,
  );
  assert.equal(aborted, true, "stream.abort() must be called on deadline");
});

test("propagates the underlying error when finalMessage rejects first", async () => {
  const stream = fakeStream<string>({ result: Promise.reject(new Error("api boom")) });
  await assert.rejects(() => finalMessageWithDeadline(stream, 1000, "test"), /api boom/);
});
