import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ApiClient, ApiError, jsonToolResult } from "../api.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("API client normalizes URLs, headers, and array query parameters", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), init };
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  const api = new ApiClient("secret", "https://example.test///");
  await api.get("/reviews", {
    appUuid: "app-id",
    query: { platforms: ["app_store"], sentiments: ["negative"], territories: ["US", "CZ"] },
  });
  assert.ok(request);
  const url = new URL(request.url);
  assert.equal(url.pathname, "/api/v1/reviews");
  assert.deepEqual(url.searchParams.getAll("platforms[]"), ["app_store"]);
  assert.deepEqual(url.searchParams.getAll("sentiments[]"), ["negative"]);
  assert.deepEqual(url.searchParams.getAll("territories[]"), ["US", "CZ"]);
  const headers = new Headers(request.init?.headers);
  assert.equal(headers.get("Authorization"), "Bearer secret");
  assert.equal(headers.get("Accept"), "application/json");
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.get("Uprate-App-Id"), "app-id");
});

test("API client supports every method, serializes write bodies, and returns null for 204", async () => {
  const calls: Array<{ method?: string; body?: unknown }> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push({ method: init?.method, body: init?.body });
    return init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const api = new ApiClient("token", "https://example.test");
  await api.get("/one");
  await api.post("/two", { body: { value: 2 } });
  await api.patch("/three", { body: { value: 3 } });
  await api.put("/four", { body: { value: 4 } });
  assert.equal(await api.delete("/five"), null);
  assert.deepEqual(calls.map((call) => call.method), ["GET", "POST", "PATCH", "PUT", "DELETE"]);
  assert.deepEqual(calls.map((call) => call.body ?? null), [null, '{"value":2}', '{"value":3}', '{"value":4}', null]);
});

test("API errors retain Laravel validation details and distinct conflict codes", async () => {
  const responses = [
    new Response(JSON.stringify({ message: "Invalid", errors: { content: ["Too long"] } }), { status: 422 }),
    new Response(JSON.stringify({ error: "review_unavailable", message: "Review cannot be replied to" }), { status: 409 }),
    new Response(JSON.stringify({ error: "response_already_published", message: "A response is already published" }), { status: 409 }),
  ];
  globalThis.fetch = async () => responses.shift()!;
  const api = new ApiClient("token");
  await assert.rejects(api.get("/invalid"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.deepEqual(error.errors, { content: ["Too long"] });
    assert.match(error.toToolResult(), /content: Too long/);
    return true;
  });
  await assert.rejects(api.get("/conflict"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "review_unavailable");
    assert.match(error.toToolResult(), /review_unavailable/);
    assert.doesNotMatch(error.toToolResult(), /already has a published response/);
    return true;
  });
  await assert.rejects(api.get("/other-conflict"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "response_already_published");
    assert.match(error.toToolResult(), /A response is already published/);
    return true;
  });
});

test("429 errors explain the 300/minute limit with optional Retry-After", async () => {
  const responses = [
    new Response(JSON.stringify({ message: "Slow down" }), { status: 429, headers: { "Retry-After": "12" } }),
    new Response(JSON.stringify({ message: "Slow down" }), { status: 429 }),
  ];
  globalThis.fetch = async () => responses.shift()!;
  const api = new ApiClient("token");
  await assert.rejects(api.get("/limited"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.match(error.toToolResult(), /300 requests per minute.*12 seconds/);
    return true;
  });
  await assert.rejects(api.get("/limited-again"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.match(error.toToolResult(), /Please wait before retrying/);
    return true;
  });
});

test("JSON tool results expose object-shaped structured content", () => {
  assert.deepEqual(jsonToolResult([1, 2]).structuredContent, { value: [1, 2] });
  assert.deepEqual(jsonToolResult({ data: 1 }).structuredContent, { data: 1 });
});
