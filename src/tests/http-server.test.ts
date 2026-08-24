import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createHttpServer } from "../http-server.js";

const server = createHttpServer({
  mcpBaseUrl: "https://mcp.example/",
  uprateBaseUrl: "https://app.example/",
  oauthStateSecret: "0123456789abcdef0123456789abcdef",
});
const originalFetch = globalThis.fetch;
let origin = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

test("HTTP server serves both protected-resource metadata routes", async () => {
  for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      resource: "https://mcp.example/mcp",
      authorization_servers: ["https://mcp.example"],
      resource_name: "Uprate MCP Server",
    });
  }
});

test("unauthenticated MCP requests return the exact RFC 9728 challenge", async () => {
  const response = await fetch(`${origin}/mcp`);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("WWW-Authenticate"), 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp"');
});

test("HTTP entry path initializes with the shared 23-tool inventory", async () => {
  globalThis.fetch = async (input, init) =>
    String(input).startsWith("https://app.example/api/v1/apps")
      ? new Response(JSON.stringify({ data: [] }), { status: 200 })
      : originalFetch(input, init);
  const client = new Client({ name: "http-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: "Bearer test-token" } },
  });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 23);
  } finally {
    await client.close();
    globalThis.fetch = originalFetch;
  }
});

test("HTTP initialization rejects invalid bearer tokens before allocating a session", async () => {
  globalThis.fetch = async (input, init) =>
    String(input).startsWith("https://app.example/api/v1/apps")
      ? new Response(JSON.stringify({ message: "Unauthenticated." }), {
          status: 401,
        })
      : originalFetch(input, init);
  const client = new Client({ name: "invalid-token-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: "Bearer invalid-token" } },
  });

  try {
    await assert.rejects(client.connect(transport));
  } finally {
    await client.close().catch(() => {});
    globalThis.fetch = originalFetch;
  }
});

test("HTTP initialization caps sessions created by one valid token", async () => {
  let validationCalls = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("https://app.example/api/v1/apps")) {
      validationCalls += 1;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    return originalFetch(input, init);
  };

  const clients: Client[] = [];
  try {
    for (let index = 0; index < 10; index += 1) {
      const client = new Client({
        name: `session-limit-test-${index}`,
        version: "1.0.0",
      });
      const transport = new StreamableHTTPClientTransport(
        new URL(`${origin}/mcp`),
        { requestInit: { headers: { Authorization: "Bearer valid-token" } } },
      );
      await client.connect(transport);
      clients.push(client);
    }

    const extraClient = new Client({
      name: "session-limit-test-extra",
      version: "1.0.0",
    });
    const extraTransport = new StreamableHTTPClientTransport(
      new URL(`${origin}/mcp`),
      { requestInit: { headers: { Authorization: "Bearer valid-token" } } },
    );
    await assert.rejects(extraClient.connect(extraTransport));
    await extraClient.close().catch(() => {});
    assert.equal(validationCalls, 10);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    globalThis.fetch = originalFetch;
  }
});
