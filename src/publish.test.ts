import { test } from "node:test";
import assert from "node:assert/strict";
process.env.TELEGRAM_BOT_TOKEN ??= "t";
process.env.ANTHROPIC_API_KEY ??= "a";
process.env.PUBLISH_BASE_URL ??= "https://w.example.workers.dev";
process.env.PUBLISH_SECRET ??= "sekret";
const { publishMenu } = await import("./publish.js");

test("publishMenu PUTs the html to the worker with the bearer secret and returns the page url", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => "ok" } as Response;
  }) as unknown as typeof fetch;

  const res = await publishMenu("planters-x", "<h1>menu</h1>", { fetch: fakeFetch });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://w.example.workers.dev/m/planters-x/index.html");
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(
    (calls[0].init.headers as Record<string, string>).authorization,
    "Bearer sekret",
  );
  assert.equal(calls[0].init.body, "<h1>menu</h1>");
  assert.equal(res.url, "https://w.example.workers.dev/m/planters-x/");
});

test("publishMenu throws on a non-2xx worker response", async () => {
  const fakeFetch = (async () =>
    ({ ok: false, status: 500, text: async () => "boom" }) as Response) as unknown as typeof fetch;
  await assert.rejects(() => publishMenu("x", "<h1>x</h1>", { fetch: fakeFetch }), /500/);
});
