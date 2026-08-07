import { wrapState, unwrapState } from "./state.js";

export interface OAuthConfig {
  mcpBaseUrl: string;
  uprateBaseUrl: string;
  oauthStateSecret: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function normalizeOAuthConfig(config: OAuthConfig): OAuthConfig {
  return {
    ...config,
    mcpBaseUrl: config.mcpBaseUrl.replace(/\/+$/, ""),
    uprateBaseUrl: config.uprateBaseUrl.replace(/\/+$/, ""),
  };
}

const jsonHeaders = { "Content-Type": "application/json" };
const noStoreJsonHeaders = { ...jsonHeaders, "Cache-Control": "no-store" };

function jsonError(status: number, error: string, description: string, noStore = false): HttpResponse {
  return {
    status,
    headers: noStore ? noStoreJsonHeaders : jsonHeaders,
    body: JSON.stringify({ error, error_description: description }),
  };
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

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${config.mcpBaseUrl}/oauth/callback`,
    response_type: "code",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state: wrapState(state, redirectUri, config.oauthStateSecret),
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
    redirectParams.set("code", code);
  } else {
    return jsonError(400, "invalid_request", "Missing code or error in callback.");
  }
  const separator = payload.r.includes("?") ? "&" : "?";
  return { status: 302, headers: { Location: `${payload.r}${separator}${redirectParams}` }, body: "" };
}

function isAbsoluteUri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const uri = new URL(value);
    return Boolean(uri.protocol);
  } catch {
    return false;
  }
}

export function handleRegistration(requestBody: string): HttpResponse {
  let body: unknown;
  try { body = JSON.parse(requestBody); }
  catch { return jsonError(400, "invalid_client_metadata", "Request body must be valid JSON.", true); }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonError(400, "invalid_client_metadata", "Request body must be a JSON object.", true);
  }
  const metadata = body as Record<string, unknown>;
  if (metadata.client_name !== undefined && typeof metadata.client_name !== "string") {
    return jsonError(400, "invalid_client_metadata", "client_name must be a string.", true);
  }
  if (!Array.isArray(metadata.redirect_uris) || metadata.redirect_uris.length === 0 || !metadata.redirect_uris.every(isAbsoluteUri)) {
    return jsonError(400, "invalid_redirect_uri", "redirect_uris must be a nonempty array of absolute URI strings.", true);
  }

  return {
    status: 201,
    headers: noStoreJsonHeaders,
    body: JSON.stringify({
      client_id: "uprate-mcp-server",
      client_name: metadata.client_name ?? "MCP Client",
      redirect_uris: metadata.redirect_uris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  };
}

export async function handleTokenExchange(requestBody: string, rawConfig: OAuthConfig): Promise<HttpResponse> {
  const config = normalizeOAuthConfig(rawConfig);
  let params: Record<string, string>;
  try {
    if (requestBody.trimStart().startsWith("{")) {
      const parsed = JSON.parse(requestBody) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      params = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
    } else {
      params = Object.fromEntries(new URLSearchParams(requestBody).entries());
    }
  } catch {
    return jsonError(400, "invalid_request", "Could not parse request body.", true);
  }

  params.redirect_uri = `${config.mcpBaseUrl}/oauth/callback`;
  try {
    const upstream = await fetch(`${config.uprateBaseUrl}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(params),
    });
    return { status: upstream.status, headers: noStoreJsonHeaders, body: await upstream.text() };
  } catch {
    return jsonError(502, "server_error", "Authorization server is unavailable.", true);
  }
}
