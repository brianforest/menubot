import { test } from "node:test";
import assert from "node:assert/strict";
import { displayCurrency } from "./currency.js";

test("displayCurrency canonicalizes RM and MYR to the same ISO+中文 display", () => {
  assert.equal(displayCurrency("RM"), "MYR（馬幣）");
  assert.equal(displayCurrency("MYR"), "MYR（馬幣）");
});

test("displayCurrency is case-insensitive and trims", () => {
  assert.equal(displayCurrency("  rm "), "MYR（馬幣）");
});

test("displayCurrency passes through an unknown code unchanged (trimmed)", () => {
  assert.equal(displayCurrency("XYZ"), "XYZ");
  assert.equal(displayCurrency("  ¤ "), "¤");
});

test("displayCurrency maps a few common regional codes", () => {
  assert.equal(displayCurrency("SGD"), "SGD（新幣）");
  assert.equal(displayCurrency("TWD"), "TWD（台幣）");
});
