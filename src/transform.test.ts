import { test } from "node:test";
import assert from "node:assert";
import { parseTransformString } from "./transform.js";

test("parseTransformString validates quality parameter q_", () => {
  assert.strictEqual(parseTransformString("q_80").quality, 80);
  assert.strictEqual(parseTransformString("q_1").quality, 1);
  assert.strictEqual(parseTransformString("q_100").quality, 100);
  assert.strictEqual(parseTransformString("q_abc").quality, undefined);
  assert.strictEqual(parseTransformString("q_0").quality, undefined);
  assert.strictEqual(parseTransformString("q_101").quality, undefined);
  assert.strictEqual(parseTransformString("q_-10").quality, undefined);
});
