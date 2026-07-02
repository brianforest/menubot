import { recordUsage, type UsageLike } from "./usage.js";

/** The slice of the SDK's MessageStream this helper needs. */
export interface DeadlineStream<T> {
  finalMessage(): Promise<T>;
  abort(): void;
}

/**
 * Await a streaming call's final message under a hard wall-clock deadline.
 *
 * The SDK's per-request `timeout` is unreliable for streams: a mid-stream
 * socket death can leave `finalMessage()` pending forever, hanging the caller
 * (observed in prod 2026-07-01 — extract wedged 20min, event loop idle). This
 * races the stream against a real timer that, on expiry, aborts the stream
 * (freeing the socket / stopping billing) and rejects — so the caller can never
 * block past `ms`, regardless of SDK behavior.
 */
export async function finalMessageWithDeadline<T>(
  stream: DeadlineStream<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        stream.abort();
      } catch {
        // best-effort: aborting a dead stream may throw; the reject below is what matters
      }
      reject(new Error(`${label} exceeded ${ms}ms hard deadline (stream stalled)`));
    }, ms);
  });
  try {
    const result = await Promise.race([stream.finalMessage(), guard]);
    // Best-effort token accounting for the timing/cost summary — real SDK
    // messages carry `usage`; fakes/other T without it are simply ignored.
    recordUsage((result as { usage?: UsageLike }).usage);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
