import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { hashBinding, unwrapState, wrapState } from "../state.js";

const now = 1_800_000_000_000;
const challenge = hashBinding("test-verifier");

test("OAuth state round-trips", () => {
  const wrapped = wrapState(
    "client-state",
    "http://localhost/callback",
    "client-id",
    challenge,
    "secret",
    now,
  );
  assert.deepEqual(unwrapState(wrapped, "secret", now), {
    s: "client-state",
    r: "http://localhost/callback",
    c: hashBinding("client-id"),
    q: challenge,
    t: now,
  });
});

test("malformed and tampered OAuth state is rejected", () => {
  assert.equal(unwrapState("not-state", "secret", now), null);
  const malformedPayload = Buffer.from(JSON.stringify({ s: 7, r: null })).toString("base64url");
  const validSignature = createHmac("sha256", "secret").update(malformedPayload).digest("base64url");
  assert.equal(unwrapState(`${malformedPayload}.${validSignature}`, "secret", now), null);
  const wrapped = wrapState("state", "http://localhost/callback", "client-id", challenge, "secret", now);
  assert.equal(unwrapState(`${wrapped.slice(0, -1)}x`, "secret", now), null);
  assert.equal(unwrapState(wrapped, "wrong-secret", now), null);
  assert.equal(unwrapState(wrapped, "secret", now + 10 * 60 * 1000 + 1), null);
  assert.equal(unwrapState(wrapped, "secret", now - 30 * 1000 - 1), null);
});
