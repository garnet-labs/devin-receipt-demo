import assert from "node:assert/strict";
import test from "node:test";
import leftPad from "left-pad";

test("pads", () => {
  assert.equal(leftPad("7", 3, "0"), "007");
});

test("pads with spaces by default", () => {
  assert.equal(leftPad("ab", 4), "  ab");
});
