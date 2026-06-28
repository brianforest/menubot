/** A buffered, not-yet-downloaded menu file (photo or PDF) awaiting "Done". */
export interface PendingItem {
  fileId: string;
  kind: "image" | "pdf";
  mime: string;
}

interface Batch {
  items: PendingItem[];
  hint?: string;
  lastActivityAt: number;
}

/**
 * Per-chat collecting sessions. Pure (no Telegram, no clock): callers pass the
 * current timestamp so the logic is deterministic and unit-testable. The bot
 * layer wires Telegram updates and the safety-net timer to these methods.
 */
export class BatchStore {
  private batches = new Map<number, Batch>();

  /** Buffer an item; isNew=true means this opened a fresh batch (send the prompt). */
  add(chatId: number, item: PendingItem, now: number): { isNew: boolean; count: number } {
    let batch = this.batches.get(chatId);
    const isNew = batch === undefined;
    if (!batch) {
      batch = { items: [], lastActivityAt: now };
      this.batches.set(chatId, batch);
    }
    batch.items.push(item);
    batch.lastActivityAt = now;
    return { isNew, count: batch.items.length };
  }

  /** Store an optional restaurant/location hint on an existing batch.
   *  Returns true if a non-empty hint was stored (a batch must already exist). */
  setHint(chatId: number, hint: string, now: number): boolean {
    const batch = this.batches.get(chatId);
    if (!batch) return false;
    const h = hint.trim();
    if (!h) return false;
    batch.hint = h;
    batch.lastActivityAt = now;
    return true;
  }

  /** Remove and return a chat's buffered items + hint (on "Done"); undefined if none. */
  take(chatId: number): { items: PendingItem[]; hint?: string } | undefined {
    const batch = this.batches.get(chatId);
    if (!batch) return undefined;
    this.batches.delete(chatId);
    return { items: batch.items, hint: batch.hint };
  }

  /** Remove batches idle for >= ttlMs; return their chat ids (for notifying). */
  expireStale(now: number, ttlMs: number): number[] {
    const expired: number[] = [];
    for (const [chatId, batch] of this.batches) {
      if (now - batch.lastActivityAt >= ttlMs) expired.push(chatId);
    }
    for (const chatId of expired) this.batches.delete(chatId);
    return expired;
  }
}
