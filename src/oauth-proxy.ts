import {
  hashBinding,
  signPayload,
  unwrapState,
  verifyPayload,
  wrapState,
} from "./state.js";

export interface OAuthConfig {
  mcpBaseUrl: string;
  uprateBaseUrl: string;
  oauthStateSecret: string;
  allowedRedirectUris?: string[];
  upstreamClientId?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function normalizeOAuthConfig(config: OAuthConfig): OAuthConfig {
  const allowedRedirectUris = config.allowedRedirectUris ?? [];
  for (const redirectUri of allowedRedirectUris) {
    if (!isCanonicalRedirectUri(redirectUri) || redirectUri.includes("*")) {
      throw new Error(`Invalid OAuth redirect URI allowlist entry: ${redirectUri}`);
    }
  }

  return {
    ...config,
    mcpBaseUrl: config.mcpBaseUrl.replace(/\/+$/, ""),
    uprateBaseUrl: config.uprateBaseUrl.replace(/\/+$/, ""),
    allowedRedirectUris,
    upstreamClientId: config.upstreamClientId ?? "uprate-mcp-server",
  };
}

const jsonHeaders = { "Content-Type": "application/json" };
const noStoreJsonHeaders = { ...jsonHeaders, "Cache-Control": "no-store" };
const MAX_REDIRECT_URI_LENGTH = 512;
const MAX_CLIENT_STATE_LENGTH = 512;
const MAX_UPSTREAM_STATE_LENGTH = 1024;
const MAX_REGISTERED_REDIRECT_URIS = 10;
const PROXY_CODE_TTL_MS = 5 * 60 * 1000;
const BUILT_IN_REDIRECT_URIS = new Set([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "https://www.cursor.com/agents/mcp/oauth/callback",
  "cursor://anysphere.cursor-mcp/oauth/callback",
]);

interface RegisteredClientPayload {
  v: 1;
  r: string[];
}

interface ProxyCodePayload {
  u: string;
  c: string;
  r: string;
  q: string;
  e: number;
}

function jsonError(status: number, error: string, description: string, noStore = false): HttpResponse {
  return {
    status,
    headers: noStore ? noStoreJsonHeaders : jsonHeaders,
    body: JSON.stringify({ error, error_description: description }),
  };
}

function isCanonicalRedirectUri(value: string): boolean {
  if (value.length === 0 || value.length > MAX_REDIRECT_URI_LENGTH) return false;

  try {
    const uri = new URL(value);
    return (
      value === uri.toString() &&
      uri.username === "" &&
      uri.password === "" &&
      uri.hash === ""
    );
  } catch {
    return false;
  }
}

function isLoopbackRedirectUri(value: string): boolean {
  if (!isCanonicalRedirectUri(value)) return false;

  const uri = new URL(value);
  return (
    uri.protocol === "http:" &&
    (uri.hostname === "localhost" ||
      uri.hostname === "127.0.0.1" ||
      uri.hostname === "[::1]")
  );
}

function exactRedirectAllowlist(config: OAuthConfig): Set<string> {
  return new Set([
    ...BUILT_IN_REDIRECT_URIS,
    ...(config.allowedRedirectUris ?? []),
  ]);
}

function isRedirectUriAllowed(value: string, config: OAuthConfig): boolean {
  return (
    isLoopbackRedirectUri(value) ||
    (isCanonicalRedirectUri(value) && exactRedirectAllowlist(config).has(value))
  );
}

function encodeRegisteredClient(
  redirectUris: string[],
  config: OAuthConfig,
): string {
  const payload = signPayload(
    { v: 1, r: redirectUris } satisfies RegisteredClientPayload,
    config.oauthStateSecret,
  );
  return `uprate-mcp.${payload}`;
}

function decodeRegisteredClient(
  clientId: string,
  config: OAuthConfig,
): RegisteredClientPayload | null {
  if (!clientId.startsWith("uprate-mcp.")) return null;
  const payload = verifyPayload(
    clientId.slice("uprate-mcp.".length),
    config.oauthStateSecret,
  );
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }

  const candidate = payload as Partial<RegisteredClientPayload>;
  if (
    candidate.v !== 1 ||
    !Array.isArray(candidate.r) ||
    candidate.r.length === 0 ||
    candidate.r.length > MAX_REGISTERED_REDIRECT_URIS ||
    !candidate.r.every(
      (value): value is string =>
        typeof value === "string" && isRedirectUriAllowed(value, config),
    )
  ) {
    return null;
  }

  return candidate as RegisteredClientPayload;
}

function isClientRedirectBindingValid(
  clientId: string,
  redirectUri: string,
  config: OAuthConfig,
): boolean {
  if (!isRedirectUriAllowed(redirectUri, config)) return false;

  if (clientId === config.upstreamClientId) {
    return exactRedirectAllowlist(config).has(redirectUri);
  }

  const client = decodeRegisteredClient(clientId, config);
  return client?.r.includes(redirectUri) === true;
}

function wrapAuthorizationCode(
  upstreamCode: string,
  clientIdHash: string,
  redirectUri: string,
  codeChallenge: string,
  config: OAuthConfig,
  now = Date.now(),
): string {
  return signPayload(
    {
      u: upstreamCode,
      c: clientIdHash,
      r: redirectUri,
      q: codeChallenge,
      e: now + PROXY_CODE_TTL_MS,
    } satisfies ProxyCodePayload,
    config.oauthStateSecret,
  );
}

function unwrapAuthorizationCode(
  code: string,
  config: OAuthConfig,
  now = Date.now(),
): ProxyCodePayload | null {
  const payload = verifyPayload(code, config.oauthStateSecret);
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }

  const candidate = payload as Partial<ProxyCodePayload>;
  if (
    typeof candidate.u !== "string" ||
    candidate.u === "" ||
    typeof candidate.c !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(candidate.c) ||
    typeof candidate.r !== "string" ||
    typeof candidate.q !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(candidate.q) ||
    typeof candidate.e !== "number" ||
    !Number.isSafeInteger(candidate.e) ||
    candidate.e < now
  ) {
    return null;
  }

  return candidate as ProxyCodePayload;
}

export function handleMetadata(rawConfig: OAuthConfig): HttpResponse {
  const config = normalizeOAuthConfig(rawConfig);
  return {
    status: 200,
    headers: jsonHeaders,
    body: JSON.stringify({
      issuer: config.mcpBaseUrl,
      authorization_endpoint: `${config.mcpBaseUrl}/oauth/authorize`,
      token_endpoint: `${config.mcpBaseUrl}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      registration_endpoint: `${config.mcpBaseUrl}/oauth/register`,
    }),
  };
}

export function handleProtectedResourceMetadata(rawConfig: OAuthConfig): HttpResponse {
  const config = normalizeOAuthConfig(rawConfig);
  return {
    status: 200,
    headers: jsonHeaders,
    body: JSON.stringify({
      resource: `${config.mcpBaseUrl}/mcp`,
      authorization_servers: [config.mcpBaseUrl],
      resource_name: "Uprate MCP Server",
    }),
  };
}

export function handleAuthorize(query: URLSearchParams, rawConfig: OAuthConfig): HttpResponse {
  const config = normalizeOAuthConfig(rawConfig);
  const clientId = query.get("client_id");
  const redirectUri = query.get("redirect_uri");
  const responseType = query.get("response_type");
  const codeChallenge = query.get("code_challenge");
  const codeChallengeMethod = query.get("code_challenge_method");
  const state = query.get("state");

  if (!clientId || !redirectUri || !responseType || !codeChallenge || !codeChallengeMethod || !state) {
    return jsonError(400, "invalid_request", "Missing required OAuth parameters.");
  }
  if (responseType !== "code") {
    return jsonError(400, "unsupported_response_type", "response_type must be code.");
  }
  if (codeChallengeMethod !== "S256") {
    return jsonError(400, "invalid_request", "code_challenge_method must be S256.");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    return jsonError(400, "invalid_request", "code_challenge must be a valid S256 challenge.");
  }
  if (state.length > MAX_CLIENT_STATE_LENGTH) {
    return jsonError(400, "invalid_request", `state must not exceed ${MAX_CLIENT_STATE_LENGTH} characters.`);
  }
  if (!isClientRedirectBindingValid(clientId, redirectUri, config)) {
    return jsonError(400, "invalid_redirect_uri", "redirect_uri is not registered for this client.");
  }

  const wrappedState = wrapState(
    state,
    redirectUri,
    clientId,
    codeChallenge,
    config.oauthStateSecret,
  );
  if (wrappedState.length > MAX_UPSTREAM_STATE_LENGTH) {
    return jsonError(400, "invalid_request", "OAuth request state and redirect_uri are too large.");
  }

  const params = new URLSearchParams({
    client_id: config.upstreamClientId!,
    redirect_uri: `${config.mcpBaseUrl}/oauth/callback`,
    response_type: "code",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state: wrappedState,
  });
  for (const optional of ["resource", "scope"] as const) {
    const value = query.get(optional);
    if (value) params.set(optional, value);
  }
  return { status: 302, headers: { Location: `${config.uprateBaseUrl}/oauth/authorize?${params}` }, body: "" };
}

export function handleCallback(query: URLSearchParams, rawConfig: OAuthConfig): HttpResponse {
  const config = normalizeOAuthConfig(rawConfig);
  const wrappedState = query.get("state");
  if (!wrappedState) return jsonError(400, "invalid_request", "Missing state parameter.");
  const payload = unwrapState(wrappedState, config.oauthStateSecret);
  if (!payload) return jsonError(400, "invalid_request", "Invalid or tampered state parameter.");

  const redirectParams = new URLSearchParams({ state: payload.s });
  const error = query.get("error");
  const code = query.get("code");
  if (error) {
    redirectParams.set("error", error);
    const description = query.get("error_description");
    if (description) redirectParams.set("error_description", description);
  } else if (code) {
    redirectParams.set(
      "code",
      wrapAuthorizationCode(code, payload.c, payload.r, payload.q, config),
    );
  } else {
    return jsonError(400, "invalid_request", "Missing code or error in callback.");
  }
  const separator = payload.r.includes("?") ? "&" : "?";
  return { status: 302, headers: { Location: `${payload.r}${separator}${redirectParams}` }, body: "" };
}

export function handleRegistration(
  requestBody: string,
  rawConfig: OAuthConfig,
): HttpResponse {
  const config = normalizeOAuthConfig(rawConfig);
  let body: unknown;
  try { body = JSON.parse(requestBody); }
  catch { return jsonError(400, "invalid_client_metadata", "Request body must be valid JSON.", true); }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonError(400, "invalid_client_metadata", "Request body must be a JSON object.", true);
  }
  const metadata = body as Record<string, unknown>;
  if (
    metadata.client_name !== undefined &&
    (typeof metadata.client_name !== "string" || metadata.client_name.length > 200)
  ) {
    return jsonError(400, "invalid_client_metadata", "client_name must be a string of at most 200 characters.", true);
  }
  if (
    !Array.isArray(metadata.redirect_uris) ||
    metadata.redirect_uris.length === 0 ||
    metadata.redirect_uris.length > MAX_REGISTERED_REDIRECT_URIS ||
    !metadata.redirect_uris.every(
      (value): value is string =>
        typeof value === "string" && isRedirectUriAllowed(value, config),
    )
  ) {
    return jsonError(
      400,
      "invalid_redirect_uri",
      "Every redirect_uri must be an exact allowlisted URI or a canonical HTTP loopback URI.",
      true,
    );
  }

  const redirectUris = [...new Set(metadata.redirect_uris)];

  return {
    status: 201,
    headers: noStoreJsonHeaders,
    body: JSON.stringify({
      client_id: encodeRegisteredClient(redirectUris, config),
      client_name: metadata.client_name ?? "MCP Client",
      redirect_uris: redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  };
}

function parseTokenParams(requestBody: string): Record<string, string> | null {
  try {
    if (requestBody.trimStart().startsWith("{")) {
      const parsed = JSON.parse(requestBody) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return null;
      }

      const entries = Object.entries(parsed);
      if (!entries.every(([, value]) => typeof value === "string")) return null;
      return Object.fromEntries(entries) as Record<string, string>;
    }

    return Object.fromEntries(new URLSearchParams(requestBody).entries());
  } catch {
    return null;
  }
}

export async function handleTokenExchange(requestBody: string, rawConfig: OAuthConfig): Promise<HttpResponse> {
  const config = normalizeOAuthConfig(rawConfig);
  const params = parseTokenParams(requestBody);
  if (!params) {
    return jsonError(400, "invalid_request", "Could not parse request body.", true);
  }

  const { client_id: clientId, redirect_uri: redirectUri, code, code_verifier: codeVerifier } = params;
  if (
    params.grant_type !== "authorization_code" ||
    !clientId ||
    !redirectUri ||
    !code ||
    !codeVerifier
  ) {
    return jsonError(
      400,
      "invalid_request",
      "grant_type, client_id, redirect_uri, code, and code_verifier are required.",
      true,
    );
  }
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) {
    return jsonError(400, "invalid_grant", "code_verifier is invalid.", true);
  }
  if (!isClientRedirectBindingValid(clientId, redirectUri, config)) {
    return jsonError(400, "invalid_grant", "Client or redirect_uri binding is invalid.", true);
  }

  const proxyCode = unwrapAuthorizationCode(code, config);
  if (
    !proxyCode ||
    proxyCode.c !== hashBinding(clientId) ||
    proxyCode.r !== redirectUri ||
    proxyCode.q !== hashBinding(codeVerifier)
  ) {
    return jsonError(400, "invalid_grant", "Authorization code binding is invalid or expired.", true);
  }

  try {
    const upstream = await fetch(`${config.uprateBaseUrl}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: config.upstreamClientId,
        redirect_uri: `${config.mcpBaseUrl}/oauth/callback`,
        code: proxyCode.u,
        code_verifier: codeVerifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: upstream.status, headers: noStoreJsonHeaders, body: await upstream.text() };
  } catch {
    return jsonError(502, "server_error", "Authorization server is unavailable.", true);
  }
}
