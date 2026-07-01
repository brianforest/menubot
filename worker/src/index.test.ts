import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest, type Env } from "./index.js";

function fakeEnv(secret = "s"): Env & { _map: Map<string, Uint8Array> } {
  const m = new Map<string, Uint8Array>();
  return {
    _map: m,
    PUBLISH_SECRET: secret,
    BUCKET: {
      get: async (k: string) =>
        m.has(k) ? { arrayBuffer: async () => m.get(k)!.buffer as ArrayBuffer } : null,
      put: async (k: string, v: ArrayBuffer) => {
        m.set(k, new Uint8Array(v));
      },
    },
  } as unknown as Env & { _map: Map<string, Uint8Array> };
}

const put = (path: string, body: string, secret?: string) =>
  new Request(`https://w.dev${path}`, {
    method: "PUT",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
    body,
  });
const get = (path: string) => new Request(`https://w.dev${path}`, { method: "GET" });

test("PUT with the right secret stores, and GET returns it as html", async () => {
  const env = fakeEnv("s");
  const w = await handleRequest(put("/m/foo/index.html", "<h1>hi</h1>", "s"), env);
  assert.equal(w.status, 200);
  const r = await handleRequest(get("/m/foo/"), env);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/html/);
  assert.match(r.headers.get("cache-control") ?? "", /max-age=31536000/);
  assert.equal(await r.text(), "<h1>hi</h1>");
});

test("GET a missing menu returns 404", async () => {
  const r = await handleRequest(get("/m/nope/"), fakeEnv());
  assert.equal(r.status, 404);
});

test("PUT without / with a wrong secret is 401 and does not store", async () => {
  const env = fakeEnv("s");
  assert.equal((await handleRequest(put("/m/foo/index.html", "x"), env)).status, 401);
  assert.equal((await handleRequest(put("/m/foo/index.html", "x", "bad"), env)).status, 401);
  assert.equal(env._map.size, 0);
});

test("a path-traversal slug is rejected and nothing is written", async () => {
  const env = fakeEnv("s");
  const res = await handleRequest(put("/m/..%2f..%2fetc/index.html", "x", "s"), env);
  assert.ok(res.status >= 400);
  assert.equal(env._map.size, 0);
});
