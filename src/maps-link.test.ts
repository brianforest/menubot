import { test } from "node:test";
import assert from "node:assert/strict";
import { findMapUrl, resolveMapContext } from "./maps-link.js";

/** Fake fetch modeling manual-redirect HEAD requests: `hops` maps a requested URL
 *  to the Location header it should answer with (or null/undefined for "final,
 *  no redirect"). Every requested URL is recorded in `calledUrls` so tests can
 *  assert which hosts were (and were not) actually fetched. */
const fakeFetch = (hops: Record<string, string | null>, calledUrls: string[] = []): typeof fetch =>
  (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    calledUrls.push(url);
    const location = Object.prototype.hasOwnProperty.call(hops, url) ? hops[url] : null;
    return {
      headers: { get: (k: string) => (k.toLowerCase() === "location" ? location : null) },
    } as unknown as Response;
  }) as unknown as typeof fetch;

test("findMapUrl accepts allow-listed hosts and rejects others", () => {
  assert.equal(findMapUrl("go here https://maps.app.goo.gl/abc please"), "https://maps.app.goo.gl/abc");
  assert.equal(findMapUrl("https://www.google.com/maps/place/X"), "https://www.google.com/maps/place/X");
  assert.equal(findMapUrl("https://evil.example.com/x"), null);
  assert.equal(findMapUrl("https://www.google.com/search?q=x"), null); // google.com but not /maps
  assert.equal(findMapUrl("no url here"), null);
});

test("findMapUrl strips trailing prose punctuation", () => {
  assert.equal(findMapUrl("見 https://maps.app.goo.gl/abc。"), "https://maps.app.goo.gl/abc");
});

test("resolveMapContext returns the decoded q= place from the redirected URL", async () => {
  const finalUrl = "https://maps.google.com/maps?q=The+Terrace+at+The+Danna%2C+Langkawi&ftid=x";
  const deps = { fetch: fakeFetch({ "https://maps.app.goo.gl/abc": finalUrl }) };
  assert.equal(await resolveMapContext("see https://maps.app.goo.gl/abc", deps), "The Terrace at The Danna, Langkawi");
});

test("resolveMapContext returns null when there is no map url", async () => {
  assert.equal(await resolveMapContext("just the name", { fetch: fakeFetch({}) }), null);
});

test("resolveMapContext returns null when the final url has no q= param", async () => {
  const finalUrl = "https://maps.google.com/maps?ll=1,2";
  const deps = { fetch: fakeFetch({ "https://maps.app.goo.gl/abc": finalUrl }) };
  assert.equal(await resolveMapContext("https://maps.app.goo.gl/abc", deps), null);
});

test("resolveMapContext returns null when fetch throws", async () => {
  const deps = { fetch: (async () => { throw new Error("net"); }) as unknown as typeof fetch };
  assert.equal(await resolveMapContext("https://maps.app.goo.gl/abc", deps), null);
});

test("resolveMapContext never fetches an open-redirect target outside the Maps allow-list (SSRF guard)", async () => {
  const calledUrls: string[] = [];
  const deps = {
    fetch: fakeFetch(
      { "https://maps.app.goo.gl/abc": "http://169.254.169.254/latest/meta-data" },
      calledUrls,
    ),
  };
  const result = await resolveMapContext("https://maps.app.goo.gl/abc", deps);
  assert.equal(result, null);
  assert.equal(calledUrls.length, 1);
  assert.ok(
    !calledUrls.some((u) => u.includes("169.254.169.254")),
    "must never emit a request to the internal/metadata host",
  );
});
