import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import {
  handleAuthorize,
  handleCallback,
  handleMetadata,
  handleProtectedResourceMetadata,
  handleRegistration,
  handleTokenExchange,
  OAuthConfig,
} from "../oauth-proxy.js";
import { hashBinding, signPayload, unwrapState } from "../state.js";

const config: OAuthConfig = {
  mcpBaseUrl: "https://mcp.example///",
  uprateBaseUrl: "https://app.example///",
  oauthStateSecret: "0123456789abcdef0123456789abcdef",
};
const redirectUri = "http://127.0.0.1:6274/oauth/callback";
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const wrongVerifier = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function registerClient(
  redirectUris: string[] = [redirectUri],
  overrideConfig: OAuthConfig = config,
): string {
  const response = handleRegistration(
    JSON.stringify({ client_name: "Test MCP client", redirect_uris: redirectUris }),
    overrideConfig,
  );
  assert.equal(response.status, 201);
  return (JSON.parse(response.body) as { client_id: string }).client_id;
}

function authorizeQuery(
  clientId = registerClient(),
  registeredRedirectUri = redirectUri,
  overrides: Record<string, string> = {},
): URLSearchParams {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: registeredRedirectUri,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "original",
    ...overrides,
  });
}

function issueProxyCode(clientId: string, callbackUri = redirectUri): string {
  const authorization = handleAuthorize(
    authorizeQuery(clientId, callbackUri),
    config,
  );
  assert.equal(authorization.status, 302);
  const wrappedState = new URL(authorization.headers.Location).searchParams.get("state");
  assert.ok(wrappedState);

  const callback = handleCallback(
    new URLSearchParams({ state: wrappedState, code: "upstream-code" }),
    config,
  );
  assert.equal(callback.status, 302);
  const code = new URL(callback.headers.Location).searchParams.get("code");
  assert.ok(code);
  assert.notEqual(code, "upstream-code");
  return code;
}

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

test("registration fails closed for redirect URI scheme, host, userinfo, and path variants", () => {
  const rejected = [
    "https://attacker.example/oauth/callback",
    "http://attacker.example/oauth/callback",
    "javascript:alert(1)",
    "https://user@claude.ai/api/mcp/auth_callback",
    "https://claude.ai@attacker.example/api/mcp/auth_callback",
    "http://claude.ai/api/mcp/auth_callback",
    "https://claude.ai/api/mcp/auth_callback/extra",
    "https://claude.ai/api/mcp/auth_callback?next=evil",
    "https://claude.ai/api/mcp/auth_callback#fragment",
    "http://127.1/oauth/callback",
    "http://127.0.0.1.attacker.example/oauth/callback",
    "http://localhost.attacker.example/oauth/callback",
    "cursor://anysphere.cursor-deeplink/mcp/oauth/callback",
  ];

  for (const candidate of rejected) {
    const response = handleRegistration(
      JSON.stringify({ redirect_uris: [candidate] }),
      config,
    );
    assert.equal(response.status, 400, candidate);
    assert.match(response.body, /invalid_redirect_uri/, candidate);
  }
});

test("registration binds a signed client id to exact approved redirects", () => {
  const redirectUris = [
    redirectUri,
    "http://[::1]:6274/oauth/callback/debug",
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
    "https://www.cursor.com/agents/mcp/oauth/callback",
  ];
  const response = handleRegistration(
    JSON.stringify({ client_name: "Codex", redirect_uris: redirectUris }),
    config,
  );
  assert.equal(response.status, 201);
  assert.equal(response.headers["Cache-Control"], "no-store");
  const body = JSON.parse(response.body) as {
    client_id: string;
    client_name: string;
    redirect_uris: string[];
  };
  assert.match(body.client_id, /^uprate-mcp\./);
  assert.notEqual(body.client_id, "uprate-mcp-server");
  assert.equal(body.client_name, "Codex");
  assert.deepEqual(body.redirect_uris, redirectUris);
});

test("registration rejects malformed metadata and wildcard allowlist entries", () => {
  for (const body of [
    "{",
    "[]",
    JSON.stringify({ redirect_uris: [] }),
    JSON.stringify({ client_name: 4, redirect_uris: [redirectUri] }),
    JSON.stringify({ redirect_uris: ["relative"] }),
  ]) {
    const response = handleRegistration(body, config);
    assert.equal(response.status, 400);
    assert.equal(response.headers["Cache-Control"], "no-store");
  }

  assert.throws(
    () => handleMetadata({ ...config, allowedRedirectUris: ["https://*.example/callback"] }),
    /Invalid OAuth redirect URI allowlist entry/,
  );
  assert.throws(
    () => handleMetadata({ ...config, oauthStateSecret: "guessable" }),
    /at least 32 bytes/,
  );
});

test("authorization enforces response type, S256 syntax, and bounded state", () => {
  assert.equal(
    handleAuthorize(authorizeQuery(undefined, undefined, { response_type: "token" }), config).status,
    400,
  );
  assert.equal(
    handleAuthorize(authorizeQuery(undefined, undefined, { code_challenge_method: "plain" }), config).status,
    400,
  );
  assert.equal(
    handleAuthorize(authorizeQuery(undefined, undefined, { code_challenge: "short" }), config).status,
    400,
  );
  assert.equal(
    handleAuthorize(authorizeQuery(undefined, undefined, { state: "x".repeat(513) }), config).status,
    400,
  );
});

test("authorization rejects unregistered and tampered client redirects", () => {
  const clientId = registerClient();
  const candidates = [
    "https://attacker.example/oauth/callback",
    `${redirectUri}/extra`,
    `${redirectUri}?next=evil`,
    redirectUri.replace("127.0.0.1", "localhost"),
  ];
  for (const candidate of candidates) {
    const response = handleAuthorize(authorizeQuery(clientId, candidate), config);
    assert.equal(response.status, 400, candidate);
    assert.match(response.body, /invalid_redirect_uri/, candidate);
  }

  const tamperedClientId = `${clientId.slice(0, -1)}x`;
  assert.equal(
    handleAuthorize(authorizeQuery(tamperedClientId), config).status,
    400,
  );
});

test("authorization forwards a fixed upstream client while binding state to the registered client", () => {
  const clientId = registerClient();
  const response = handleAuthorize(
    authorizeQuery(clientId, redirectUri, {
      resource: "https://mcp.example/mcp",
      scope: "api profile",
    }),
    config,
  );
  assert.equal(response.status, 302);
  const upstream = new URL(response.headers.Location);
  assert.equal(upstream.origin, "https://app.example");
  assert.equal(upstream.searchParams.get("client_id"), "uprate-mcp-server");
  assert.equal(upstream.searchParams.get("resource"), "https://mcp.example/mcp");
  assert.equal(upstream.searchParams.get("scope"), "api profile");
  assert.equal(upstream.searchParams.get("code_challenge"), challenge);
  const state = unwrapState(
    upstream.searchParams.get("state")!,
    config.oauthStateSecret,
  );
  assert.equal(state?.s, "original");
  assert.equal(state?.r, redirectUri);
  assert.equal(state?.c, hashBinding(clientId));
});

test("callback restores OAuth errors only to the signed registered redirect", () => {
  const clientId = registerClient();
  const authorization = handleAuthorize(authorizeQuery(clientId), config);
  const state = new URL(authorization.headers.Location).searchParams.get("state")!;
  const failure = handleCallback(
    new URLSearchParams({
      state,
      error: "access_denied",
      error_description: "No",
    }),
    config,
  );
  const redirect = new URL(failure.headers.Location);
  assert.equal(redirect.origin + redirect.pathname, redirectUri);
  assert.equal(redirect.searchParams.get("state"), "original");
  assert.equal(redirect.searchParams.get("error"), "access_denied");
  assert.equal(redirect.searchParams.get("error_description"), "No");
});

test("token exchange enforces exact client, redirect, code, and PKCE binding before proxying", async () => {
  const clientId = registerClient();
  const proxyCode = issueProxyCode(clientId);
  const otherRedirect = "http://localhost:6274/oauth/callback/debug";
  const otherClientId = registerClient([otherRedirect]);
  const upstreamRequests: Array<{ url: string; body: Record<string, string> }> = [];
  globalThis.fetch = async (input, init) => {
    upstreamRequests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, string>,
    });
    return new Response(JSON.stringify({ access_token: "token" }), { status: 200 });
  };

  const valid = await handleTokenExchange(
    JSON.stringify({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code: proxyCode,
      code_verifier: verifier,
    }),
    config,
  );
  assert.equal(valid.status, 200);
  assert.equal(upstreamRequests.length, 1);
  assert.deepEqual(upstreamRequests[0], {
    url: "https://app.example/api/oauth/token",
    body: {
      grant_type: "authorization_code",
      client_id: "uprate-mcp-server",
      redirect_uri: "https://mcp.example/oauth/callback",
      code: "upstream-code",
      code_verifier: verifier,
    },
  });

  const rejectedBodies = [
    {
      grant_type: "authorization_code",
      client_id: otherClientId,
      redirect_uri: otherRedirect,
      code: proxyCode,
      code_verifier: verifier,
    },
    {
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: `${redirectUri}/extra`,
      code: proxyCode,
      code_verifier: verifier,
    },
    {
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code: "upstream-code",
      code_verifier: verifier,
    },
    {
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code: proxyCode,
      code_verifier: wrongVerifier,
    },
    {
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code: signPayload(
        {
          u: "upstream-code",
          c: hashBinding(clientId),
          r: redirectUri,
          q: challenge,
          e: Date.now() - 1,
        },
        config.oauthStateSecret,
      ),
      code_verifier: verifier,
    },
  ];

  for (const body of rejectedBodies) {
    const response = await handleTokenExchange(JSON.stringify(body), config);
    assert.equal(response.status, 400);
    assert.equal(response.headers["Cache-Control"], "no-store");
  }
  assert.equal(upstreamRequests.length, 1);
});

test("legacy static client works only with an exact server-side allowlisted redirect", () => {
  const exact = "https://claude.ai/api/mcp/auth_callback";
  assert.equal(
    handleAuthorize(authorizeQuery("uprate-mcp-server", exact), config).status,
    302,
  );
  assert.equal(
    handleAuthorize(
      authorizeQuery("uprate-mcp-server", `${exact}/extra`),
      config,
    ).status,
    400,
  );
  assert.equal(
    handleAuthorize(
      authorizeQuery("uprate-mcp-server", redirectUri),
      config,
    ).status,
    400,
  );
});

test("token exchange rejects malformed input without contacting Uprate", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  };

  for (const body of ["{", "[]", "{}", JSON.stringify({ code: 7 })]) {
    const response = await handleTokenExchange(body, config);
    assert.equal(response.status, 400);
    assert.equal(response.headers["Cache-Control"], "no-store");
  }
  assert.equal(calls, 0);
});
