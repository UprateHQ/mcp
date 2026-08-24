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
  const client = new Client({ name: "http-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: "Bearer test-token" } },
  });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 23);
  } finally {
    await client.close();
  }
});
