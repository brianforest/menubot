import { test } from "node:test";
import assert from "node:assert/strict";
import { displayCurrency, currencyPrefix } from "./currency.js";

test("displayCurrency canonicalizes RM and MYR to the same ISO+中文 display", () => {
  assert.equal(displayCurrency("RM"), "MYR (馬幣)");
  assert.equal(displayCurrency("MYR"), "MYR (馬幣)");
});

test("displayCurrency is case-insensitive and trims", () => {
  assert.equal(displayCurrency("  rm "), "MYR (馬幣)");
});

test("displayCurrency passes through an unknown code unchanged (trimmed)", () => {
  assert.equal(displayCurrency("XYZ"), "XYZ");
  assert.equal(displayCurrency("  ¤ "), "¤");
});

test("displayCurrency maps a few common regional codes", () => {
  assert.equal(displayCurrency("SGD"), "SGD (新幣)");
  assert.equal(displayCurrency("TWD"), "TWD (台幣)");
});

test("currencyPrefix maps common codes to a short money marker", () => {
  assert.equal(currencyPrefix("MYR"), "RM");
  assert.equal(currencyPrefix("RM"), "RM");
  assert.equal(currencyPrefix("SGD"), "S$");
  assert.equal(currencyPrefix("USD"), "$");
  assert.equal(currencyPrefix("EUR"), "€");
  assert.equal(currencyPrefix("TWD"), "NT$");
});

test("currencyPrefix falls back to the trimmed code and handles empty", () => {
  assert.equal(currencyPrefix("XYZ"), "XYZ");
  assert.equal(currencyPrefix(""), "");
  assert.equal(currencyPrefix(undefined), "");
});
