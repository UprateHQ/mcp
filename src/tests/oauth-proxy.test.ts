import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  handleAuthorize, handleCallback, handleMetadata, handleProtectedResourceMetadata,
  handleRegistration, handleTokenExchange, OAuthConfig,
} from "../oauth-proxy.js";
import { unwrapState } from "../state.js";

const config: OAuthConfig = {
  mcpBaseUrl: "https://mcp.example///",
  uprateBaseUrl: "https://app.example///",
  oauthStateSecret: "state-secret",
};
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("authorization-server and protected-resource metadata are normalized", () => {
  assert.deepEqual(JSON.parse(handleMetadata(config).body), {
    issuer: "https://mcp.example",
    authorization_endpoint: "https://mcp.example/oauth/authorize",
    token_endpoint: "https://mcp.example/oauth/token",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    registration_endpoint: "https://mcp.example/oauth/register",
  });
  assert.deepEqual(JSON.parse(handleProtectedResourceMetadata(config).body), {
    resource: "https://mcp.example/mcp",
    authorization_servers: ["https://mcp.example"],
    resource_name: "Uprate MCP Server",
  });
});

function authorizeQuery(overrides: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    client_id: "client", redirect_uri: "http://127.0.0.1/callback", response_type: "code",
    code_challenge: "challenge", code_challenge_method: "S256", state: "original",
    ...overrides,
  });
}

test("authorization rejects unsupported response type and PKCE method", () => {
  assert.equal(handleAuthorize(authorizeQuery({ response_type: "token" }), config).status, 400);
  assert.match(handleAuthorize(authorizeQuery({ response_type: "token" }), config).body, /unsupported_response_type/);
  assert.equal(handleAuthorize(authorizeQuery({ code_challenge_method: "plain" }), config).status, 400);
  assert.match(handleAuthorize(authorizeQuery({ code_challenge_method: "plain" }), config).body, /S256/);
});

test("authorization forwards resource, scope, state, and PKCE", () => {
  const response = handleAuthorize(authorizeQuery({ resource: "https://mcp.example/mcp", scope: "api profile" }), config);
  assert.equal(response.status, 302);
  const upstream = new URL(response.headers.Location);
  assert.equal(upstream.origin, "https://app.example");
  assert.equal(upstream.searchParams.get("resource"), "https://mcp.example/mcp");
  assert.equal(upstream.searchParams.get("scope"), "api profile");
  assert.equal(upstream.searchParams.get("code_challenge"), "challenge");
  assert.equal(upstream.searchParams.get("code_challenge_method"), "S256");
  assert.deepEqual(unwrapState(upstream.searchParams.get("state")!, "state-secret"), {
    s: "original", r: "http://127.0.0.1/callback",
  });
});

test("callback restores success and OAuth error redirects", () => {
  const authorize = handleAuthorize(authorizeQuery(), config);
  const state = new URL(authorize.headers.Location).searchParams.get("state")!;
  const success = handleCallback(new URLSearchParams({ state, code: "auth-code" }), config);
  assert.equal(new URL(success.headers.Location).searchParams.get("code"), "auth-code");
  assert.equal(new URL(success.headers.Location).searchParams.get("state"), "original");
  const failure = handleCallback(new URLSearchParams({ state, error: "access_denied", error_description: "No" }), config);
  assert.equal(new URL(failure.headers.Location).searchParams.get("error"), "access_denied");
  assert.equal(new URL(failure.headers.Location).searchParams.get("error_description"), "No");
});

test("registration validates JSON object, client name, and absolute redirect URIs with no-store", () => {
  for (const body of ["{", "[]", JSON.stringify({ redirect_uris: [] }), JSON.stringify({ client_name: 4, redirect_uris: ["http://localhost"] }), JSON.stringify({ redirect_uris: ["relative"] })]) {
    const response = handleRegistration(body);
    assert.equal(response.status, 400);
    assert.equal(response.headers["Cache-Control"], "no-store");
  }
  const response = handleRegistration(JSON.stringify({ client_name: "Codex", redirect_uris: ["http://127.0.0.1/callback", "custom://callback"] }));
  assert.equal(response.status, 201);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.equal(JSON.parse(response.body).client_name, "Codex");
});

test("token exchange proxies normalized URL and always uses no-store", async () => {
  let seenUrl = "";
  let seenBody = "";
  globalThis.fetch = async (input, init) => {
    seenUrl = String(input); seenBody = String(init?.body);
    return new Response(JSON.stringify({ access_token: "token" }), { status: 200 });
  };
  const response = await handleTokenExchange(JSON.stringify({ code: "code", redirect_uri: "client" }), config);
  assert.equal(seenUrl, "https://app.example/api/oauth/token");
  assert.equal(JSON.parse(seenBody).redirect_uri, "https://mcp.example/oauth/callback");
  assert.equal(response.headers["Cache-Control"], "no-store");
  const malformed = await handleTokenExchange("{", config);
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers["Cache-Control"], "no-store");
});
