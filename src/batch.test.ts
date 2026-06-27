import { test } from "node:test";
import assert from "node:assert/strict";
import { BatchStore, type PendingItem } from "./batch.js";

const item = (id: string): PendingItem => ({ fileId: id, kind: "image", mime: "image/jpeg" });

test("first add to a chat is new; subsequent adds are not, count grows", () => {
  const store = new BatchStore();
  assert.deepEqual(store.add(1, item("a"), 1000), { isNew: true, count: 1 });
  assert.deepEqual(store.add(1, item("b"), 1100), { isNew: false, count: 2 });
  assert.deepEqual(store.add(1, item("c"), 1200), { isNew: false, count: 3 });
});

test("different chats have independent batches", () => {
  const store = new BatchStore();
  assert.equal(store.add(1, item("a"), 1000).isNew, true);
  assert.equal(store.add(2, item("a"), 1000).isNew, true);
  assert.equal(store.add(1, item("b"), 1000).count, 2);
  assert.equal(store.add(2, item("b"), 1000).count, 2);
});

test("take returns the items and clears the batch", () => {
  const store = new BatchStore();
  store.add(1, item("a"), 1000);
  store.add(1, item("b"), 1000);
  const taken = store.take(1);
  assert.deepEqual(taken?.map((i) => i.fileId), ["a", "b"]);
  assert.equal(store.take(1), undefined); // cleared
});

test("take on an unknown chat returns undefined", () => {
  const store = new BatchStore();
  assert.equal(store.take(99), undefined);
});

test("expireStale returns and removes only batches idle >= ttl", () => {
  const store = new BatchStore();
  store.add(1, item("a"), 1000); // last activity 1000
  store.add(2, item("a"), 5000); // last activity 5000
  const ttl = 2000;
  // now = 4000: chat 1 idle 3000 (>= ttl) expires; chat 2 idle -1000 stays
  assert.deepEqual(store.expireStale(4000, ttl), [1]);
  assert.equal(store.take(1), undefined); // removed
  assert.notEqual(store.take(2), undefined); // still there
});

test("activity resets the idle clock", () => {
  const store = new BatchStore();
  store.add(1, item("a"), 1000);
  store.add(1, item("b"), 3000); // resets lastActivityAt to 3000
  const ttl = 2000;
  assert.deepEqual(store.expireStale(4000, ttl), []); // idle 1000 < ttl
  assert.deepEqual(store.expireStale(5000, ttl), [1]); // idle 2000 >= ttl
});
