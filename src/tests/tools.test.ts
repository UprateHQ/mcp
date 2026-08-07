import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, test } from "node:test";
import { ApiClient } from "../api.js";
import { createUprateServer, VERSION } from "../server.js";

const APP_UUID = "11111111-1111-4111-8111-111111111111";
const REVIEW_UUID = "22222222-2222-4222-8222-222222222222";
const RULE_UUID = "33333333-3333-4333-8333-333333333333";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

async function connectClient() {
  const server = createUprateServer(new ApiClient("token", "https://api.example"));
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test("shared server factory exposes exactly 23 annotated tools", async () => {
  assert.equal(VERSION, "1.2.0");
  const first = await connectClient();
  const second = await connectClient();
  try {
    const inventories = await Promise.all([first.client.listTools(), second.client.listTools()]);
    assert.equal(inventories[0].tools.length, 23);
    assert.deepEqual(inventories[0].tools.map((tool) => tool.name), inventories[1].tools.map((tool) => tool.name));
    for (const tool of inventories[0].tools) {
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", tool.name);
      assert.equal(typeof tool.annotations?.destructiveHint, "boolean", tool.name);
      assert.equal(typeof tool.annotations?.idempotentHint, "boolean", tool.name);
      assert.equal(typeof tool.annotations?.openWorldHint, "boolean", tool.name);
    }
    const byName = Object.fromEntries(inventories[0].tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.toggle_automation_rule.annotations?.idempotentHint, false);
    assert.equal(byName.delete_automation_rule.annotations?.destructiveHint, true);
    assert.equal(byName.get_review_soul.annotations?.readOnlyHint, true);
    assert.equal(byName.update_review_soul.annotations?.destructiveHint, true);
    assert.equal(byName.reply_to_review.annotations?.destructiveHint, true);

    // Regression: a ZodEffects inputSchema serializes to an empty JSON schema,
    // silently hiding every parameter from clients. Assert the published
    // schemas keep their properties.
    const listReviewsProps = Object.keys(byName.list_reviews.inputSchema.properties ?? {});
    for (const prop of ["app_uuid", "platforms", "rating_min", "date_from", "date_to"]) {
      assert.ok(listReviewsProps.includes(prop), `list_reviews schema missing ${prop}`);
    }
    assert.ok(byName.create_automation_rule.inputSchema.properties?.condition, "create_automation_rule schema missing condition");
  } finally {
    await first.client.close(); await second.client.close();
  }
});

test("automation tools validate strict discriminators and send exact methods, URLs, and bodies", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
  };
  const { client } = await connectClient();
  try {
    await client.callTool({ name: "list_automation_rules", arguments: {} });
    await client.callTool({ name: "create_automation_rule", arguments: {
      app_uuid: null, scope: "review.publish_replies", condition: { type: "schedule", block_days: [1, 7] }, action: "require_approval",
    } });
    await client.callTool({ name: "toggle_automation_rule", arguments: { rule_uuid: RULE_UUID } });
    await client.callTool({ name: "delete_automation_rule", arguments: { rule_uuid: RULE_UUID } });
    assert.deepEqual(requests.map(({ url, init }) => [init?.method, new URL(url).pathname]), [
      ["GET", "/api/v1/automation-rules"],
      ["POST", "/api/v1/automation-rules"],
      ["PATCH", `/api/v1/automation-rules/${RULE_UUID}/toggle`],
      ["DELETE", `/api/v1/automation-rules/${RULE_UUID}`],
    ]);
    assert.deepEqual(JSON.parse(String(requests[1].init?.body)), {
      app_uuid: null, scope: "review.publish_replies", condition: { type: "schedule", block_days: [1, 7] }, action: "require_approval",
    });

    const invalid = [
      { app_uuid: null, scope: "bad", condition: { type: "always" }, action: "auto" },
      { app_uuid: null, scope: "*", condition: { type: "always", ratings: [1] }, action: "auto" },
      { app_uuid: null, scope: "*", condition: { type: "schedule", block_days: [] }, action: "auto" },
      { app_uuid: null, scope: "*", condition: { type: "rating_filter", ratings: [6] }, action: "auto" },
      { app_uuid: null, scope: "*", condition: { type: "keyword_filter", keywords: ["x".repeat(51)] }, action: "auto" },
      { app_uuid: null, scope: "*", condition: { type: "always" }, action: "allow" },
    ];
    for (const args of invalid) {
      const result = await client.callTool({ name: "create_automation_rule", arguments: args });
      assert.equal(result.isError, true);
    }
    assert.equal(requests.length, 4);
  } finally { await client.close(); }
});

test("Soul tools enforce 10,000 characters and use GET/PUT with the exact body", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({ data: { version: 1 } }), { status: 200 });
  };
  const { client } = await connectClient();
  try {
    await client.callTool({ name: "get_review_soul", arguments: { app_uuid: APP_UUID } });
    await client.callTool({ name: "update_review_soul", arguments: { app_uuid: APP_UUID, content: "x".repeat(10_000) } });
    const invalid = await client.callTool({ name: "update_review_soul", arguments: { app_uuid: APP_UUID, content: "x".repeat(10_001) } });
    assert.equal(invalid.isError, true);
    assert.deepEqual(requests.map(({ url, init }) => [init?.method, new URL(url).pathname]), [
      ["GET", `/api/v1/apps/${APP_UUID}/soul`], ["PUT", `/api/v1/apps/${APP_UUID}/soul`],
    ]);
    assert.deepEqual(JSON.parse(String(requests[1].init?.body)), { content: "x".repeat(10_000) });
  } finally { await client.close(); }
});

test("review filters reject invalid dates and cross-field ranges", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
  const { client } = await connectClient();
  try {
    for (const args of [
      { app_uuid: APP_UUID, date_from: "2026-02-30" },
      { app_uuid: APP_UUID, date_from: "2026-02-02", date_to: "2026-02-01" },
      { app_uuid: APP_UUID, rating_min: 5, rating_max: 2 },
    ]) {
      const result = await client.callTool({ name: "list_reviews", arguments: args });
      assert.equal(result.isError, true);
    }
  } finally { await client.close(); }
});

test("review replies default to drafts and surface failed publication with preserved structured data", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const published = bodies.length === 1;
    return new Response(JSON.stringify({ data: { is_published: published, content: "Preserved reply" } }), { status: 201 });
  };
  const { client } = await connectClient();
  try {
    const draft = await client.callTool({ name: "reply_to_review", arguments: { app_uuid: APP_UUID, review_uuid: REVIEW_UUID, content: "A helpful response" } });
    assert.equal(bodies[0].draft, true);
    assert.equal(draft.isError, undefined);
    const failed = await client.callTool({ name: "reply_to_review", arguments: { app_uuid: APP_UUID, review_uuid: REVIEW_UUID, content: "A helpful response", draft: false } });
    assert.equal(failed.isError, true);
    const content = failed.content as Array<{ text: string }>;
    assert.match(content[0].text, /PUBLICATION FAILED.*preserved.*draft/is);
    assert.deepEqual(failed.structuredContent, { data: { is_published: false, content: "Preserved reply" } });
  } finally { await client.close(); }
});

test("reply context makes exactly the two scoped upstream requests", async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  };
  const { client } = await connectClient();
  try {
    const result = await client.callTool({ name: "get_review_reply_context", arguments: { app_uuid: APP_UUID, review_uuid: REVIEW_UUID } });
    assert.deepEqual(requests.map(({ url }) => new URL(url).pathname).sort(), [
      `/api/v1/apps/${APP_UUID}/soul`, `/api/v1/reviews/${REVIEW_UUID}`,
    ]);
    const reviewRequest = requests.find(({ url }) => url.endsWith(`/reviews/${REVIEW_UUID}`));
    assert.equal(reviewRequest?.headers.get("Uprate-App-Id"), APP_UUID);
    assert.deepEqual(result.structuredContent, { review: { data: {} }, soul: { data: {} } });
  } finally { await client.close(); }
});
