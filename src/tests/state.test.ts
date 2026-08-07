import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { unwrapState, wrapState } from "../state.js";

test("OAuth state round-trips", () => {
  const wrapped = wrapState("client-state", "http://localhost/callback", "secret");
  assert.deepEqual(unwrapState(wrapped, "secret"), { s: "client-state", r: "http://localhost/callback" });
});

test("malformed and tampered OAuth state is rejected", () => {
  assert.equal(unwrapState("not-state", "secret"), null);
  const malformedPayload = Buffer.from(JSON.stringify({ s: 7, r: null })).toString("base64url");
  const validSignature = createHmac("sha256", "secret").update(malformedPayload).digest("base64url");
  assert.equal(unwrapState(`${malformedPayload}.${validSignature}`, "secret"), null);
  const wrapped = wrapState("state", "http://localhost/callback", "secret");
  assert.equal(unwrapState(`${wrapped.slice(0, -1)}x`, "secret"), null);
  assert.equal(unwrapState(wrapped, "wrong-secret"), null);
});
