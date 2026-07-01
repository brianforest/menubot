import { test } from "node:test";
import assert from "node:assert/strict";
import { findMapUrl, resolveMapContext } from "./maps-link.js";

const fakeFetch = (finalUrl: string): typeof fetch =>
  (async () => ({ url: finalUrl }) as Response) as unknown as typeof fetch;

test("findMapUrl accepts allow-listed hosts and rejects others", () => {
  assert.equal(findMapUrl("go here https://maps.app.goo.gl/abc please"), "https://maps.app.goo.gl/abc");
  assert.equal(findMapUrl("https://www.google.com/maps/place/X"), "https://www.google.com/maps/place/X");
  assert.equal(findMapUrl("https://evil.example.com/x"), null);
  assert.equal(findMapUrl("https://www.google.com/search?q=x"), null); // google.com but not /maps
  assert.equal(findMapUrl("no url here"), null);
});

test("resolveMapContext returns the decoded q= place from the redirected URL", async () => {
  const deps = { fetch: fakeFetch("https://maps.google.com/maps?q=The+Terrace+at+The+Danna%2C+Langkawi&ftid=x") };
  assert.equal(await resolveMapContext("see https://maps.app.goo.gl/abc", deps), "The Terrace at The Danna, Langkawi");
});

test("resolveMapContext returns null when there is no map url", async () => {
  assert.equal(await resolveMapContext("just the name", { fetch: fakeFetch("x") }), null);
});

test("resolveMapContext returns null when the final url has no q= param", async () => {
  const deps = { fetch: fakeFetch("https://maps.google.com/maps?ll=1,2") };
  assert.equal(await resolveMapContext("https://maps.app.goo.gl/abc", deps), null);
});

test("resolveMapContext returns null when fetch throws", async () => {
  const deps = { fetch: (async () => { throw new Error("net"); }) as unknown as typeof fetch };
  assert.equal(await resolveMapContext("https://maps.app.goo.gl/abc", deps), null);
});
