// src/oauth-proxy.ts
import { wrapState, unwrapState } from "./state.js";

export interface OAuthConfig {
  mcpBaseUrl: string;       // e.g. "https://mcp.upratehq.com"
  uprateBaseUrl: string;    // e.g. "https://app.upratehq.com"
  oauthStateSecret: string; // HMAC secret
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * GET /.well-known/oauth-authorization-server
 */
export function handleMetadata(config: OAuthConfig): HttpResponse {
  const metadata = {
    issuer: config.mcpBaseUrl,
    authorization_endpoint: `${config.mcpBaseUrl}/oauth/authorize`,
    token_endpoint: `${config.mcpBaseUrl}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    registration_endpoint: `${config.mcpBaseUrl}/oauth/register`,
  };
  return {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
  };
}

/**
 * GET /oauth/authorize — redirect browser to Laravel backend
 */
export function handleAuthorize(
  query: URLSearchParams,
  config: OAuthConfig
): HttpResponse {
  const clientId = query.get("client_id");
  const redirectUri = query.get("redirect_uri");
  const responseType = query.get("response_type");
  const codeChallenge = query.get("code_challenge");
  const codeChallengeMethod = query.get("code_challenge_method");
  const state = query.get("state");

  if (!clientId || !redirectUri || !responseType || !codeChallenge || !codeChallengeMethod || !state) {
    return {
      status: 400,
      headers: { "Content-Type": "text/plain" },
      body: "Missing required OAuth parameters.",
    };
  }

  const wrappedState = wrapState(state, redirectUri, config.oauthStateSecret);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${config.mcpBaseUrl}/oauth/callback`,
    response_type: responseType,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    state: wrappedState,
  });

  const location = `${config.uprateBaseUrl}/oauth/authorize?${params.toString()}`;
  return {
    status: 302,
    headers: { Location: location },
    body: "",
  };
}

/**
 * GET /oauth/callback — receive code from Laravel, redirect to MCP client
 */
export function handleCallback(
  query: URLSearchParams,
  config: OAuthConfig
): HttpResponse {
  const wrappedState = query.get("state");
  if (!wrappedState) {
    return {
      status: 400,
      headers: { "Content-Type": "text/plain" },
      body: "Missing state parameter.",
    };
  }

  const payload = unwrapState(wrappedState, config.oauthStateSecret);
  if (!payload) {
    return {
      status: 400,
      headers: { "Content-Type": "text/plain" },
      body: "Invalid or tampered state parameter.",
    };
  }

  const code = query.get("code");
  const error = query.get("error");
  const errorDescription = query.get("error_description");

  const redirectParams = new URLSearchParams();
  redirectParams.set("state", payload.s);

  if (error) {
    redirectParams.set("error", error);
    if (errorDescription) {
      redirectParams.set("error_description", errorDescription);
    }
  } else if (code) {
    redirectParams.set("code", code);
  } else {
    return {
      status: 400,
      headers: { "Content-Type": "text/plain" },
      body: "Missing code or error in callback.",
    };
  }

  const location = `${payload.r}?${redirectParams.toString()}`;
  return {
    status: 302,
    headers: { Location: location },
    body: "",
  };
}

/**
 * POST /oauth/register — dynamic client registration (RFC 7591)
 * Returns the hardcoded client_id regardless of request content.
 */
export function handleRegistration(requestBody: string): HttpResponse {
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(requestBody) as Record<string, unknown>;
  } catch {
    // ignore parse errors, we don't need the body
  }

  const response = {
    client_id: "uprate-mcp-server",
    client_name: body.client_name ?? "MCP Client",
    redirect_uris: body.redirect_uris ?? [],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };

  return {
    status: 201,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(response),
  };
}

/**
 * POST /oauth/token — proxy token exchange to Laravel backend
 */
export async function handleTokenExchange(
  requestBody: string,
  config: OAuthConfig
): Promise<HttpResponse> {
  let params: Record<string, string>;

  try {
    // Try JSON first, fall back to form-encoded
    if (requestBody.startsWith("{")) {
      params = JSON.parse(requestBody) as Record<string, string>;
    } else {
      const parsed = new URLSearchParams(requestBody);
      params = Object.fromEntries(parsed.entries());
    }
  } catch {
    return {
      status: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "invalid_request", error_description: "Could not parse request body." }),
    };
  }

  // Replace redirect_uri with the MCP server's callback URL
  params.redirect_uri = `${config.mcpBaseUrl}/oauth/callback`;

  try {
    const upstreamResponse = await fetch(`${config.uprateBaseUrl}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(params),
    });

    const responseBody = await upstreamResponse.text();
    return {
      status: upstreamResponse.status,
      headers: { "Content-Type": "application/json" },
      body: responseBody,
    };
  } catch {
    return {
      status: 502,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "server_error", error_description: "Authorization server is unavailable." }),
    };
  }
}
