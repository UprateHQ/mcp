import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ApiClient, ApiError } from "./api.js";
import {
  handleAuthorize, handleCallback, handleMetadata, handleProtectedResourceMetadata,
  handleRegistration, handleTokenExchange, normalizeOAuthConfig, OAuthConfig,
} from "./oauth-proxy.js";
import { createUprateServer } from "./server.js";

interface Session {
  server: ReturnType<typeof createUprateServer>;
  transport: StreamableHTTPServerTransport;
  token: string;
  lastActivity: number;
}

interface SessionRegistry {
  active: Map<string, Session>;
  pending: number;
  pendingByToken: Map<string, number>;
}

const MAX_SESSIONS = 1000;
const MAX_SESSIONS_PER_TOKEN = 10;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function extractBearerToken(req: IncomingMessage): string | null {
  return req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error("Request body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function sendResponse(res: ServerResponse, status: number, headers: Record<string, string>, body: string): void {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  sendResponse(res, status, { "Content-Type": "application/json", ...headers }, JSON.stringify(data));
}

function sendUnauthorized(res: ServerResponse, config: OAuthConfig, message = "Unauthorized"): void {
  sendJson(res, 401, { error: message }, {
    "WWW-Authenticate": `Bearer resource_metadata="${config.mcpBaseUrl}/.well-known/oauth-protected-resource/mcp"`,
  });
}

export function createHttpServer(rawConfig: OAuthConfig): Server {
  const config = normalizeOAuthConfig(rawConfig);
  const sessions: SessionRegistry = {
    active: new Map<string, Session>(),
    pending: 0,
    pendingByToken: new Map<string, number>(),
  };
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions.active) {
      if (now - session.lastActivity > SESSION_IDLE_TIMEOUT_MS) {
        session.transport.close().catch(() => {});
        sessions.active.delete(id);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  cleanup.unref();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method ?? "GET";
    try {
      if (method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
        const result = handleMetadata(config); sendResponse(res, result.status, result.headers, result.body); return;
      }
      if (method === "GET" && ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"].includes(url.pathname)) {
        const result = handleProtectedResourceMetadata(config); sendResponse(res, result.status, result.headers, result.body); return;
      }
      if (method === "GET" && url.pathname === "/oauth/authorize") {
        const result = handleAuthorize(url.searchParams, config); sendResponse(res, result.status, result.headers, result.body); return;
      }
      if (method === "GET" && url.pathname === "/oauth/callback") {
        const result = handleCallback(url.searchParams, config); sendResponse(res, result.status, result.headers, result.body); return;
      }
      if (method === "POST" && url.pathname === "/oauth/register") {
        const result = handleRegistration(await readBody(req), config); sendResponse(res, result.status, result.headers, result.body); return;
      }
      if (method === "POST" && url.pathname === "/oauth/token") {
        const result = await handleTokenExchange(await readBody(req), config); sendResponse(res, result.status, result.headers, result.body); return;
      }
      if (url.pathname === "/mcp") { await handleMcpRequest(req, res, sessions, config); return; }
      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      console.error("Unhandled error:", error);
      sendJson(res, 500, { error: "Internal server error" });
    }
  });
  server.on("close", () => clearInterval(cleanup));
  return server;
}

export function startHttpServer(config: OAuthConfig & { port: number }): Server {
  const server = createHttpServer(config);
  server.listen(config.port, () => console.error(`Uprate MCP server running on http://0.0.0.0:${config.port}`));
  return server;
}

function countActiveSessionsForToken(sessions: SessionRegistry, token: string): number {
  let count = 0;
  for (const session of sessions.active.values()) {
    if (session.token === token) count += 1;
  }
  return count;
}

function reserveInitialization(sessions: SessionRegistry, token: string): boolean {
  const pendingForToken = sessions.pendingByToken.get(token) ?? 0;
  if (
    sessions.active.size + sessions.pending >= MAX_SESSIONS ||
    countActiveSessionsForToken(sessions, token) + pendingForToken >=
      MAX_SESSIONS_PER_TOKEN
  ) {
    return false;
  }

  sessions.pending += 1;
  sessions.pendingByToken.set(token, pendingForToken + 1);
  return true;
}

function releaseInitialization(sessions: SessionRegistry, token: string): void {
  sessions.pending -= 1;
  const pendingForToken = (sessions.pendingByToken.get(token) ?? 1) - 1;
  if (pendingForToken === 0) sessions.pendingByToken.delete(token);
  else sessions.pendingByToken.set(token, pendingForToken);
}

async function validateToken(
  api: ApiClient,
  res: ServerResponse,
  config: OAuthConfig,
): Promise<boolean> {
  try {
    await api.get("/apps", { query: { per_page: 1 } });
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      sendUnauthorized(res, config, "Invalid or expired access token.");
      return false;
    }

    console.error(
      "Unable to validate MCP access token:",
      error instanceof ApiError
        ? `Uprate API returned ${error.status}`
        : error instanceof Error
          ? error.name
          : "Unknown error",
    );
    sendJson(res, 503, {
      error: "Unable to validate access token. Try again later.",
    });
    return false;
  }
}

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, sessions: SessionRegistry, config: OAuthConfig): Promise<void> {
  const method = req.method ?? "GET";
  const token = extractBearerToken(req);
  if (!token) { sendUnauthorized(res, config); return; }

  const rawId = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(rawId) ? rawId[0] : rawId;
  if (sessionId) {
    const session = sessions.active.get(sessionId);
    if (!session) { sendJson(res, 404, { jsonrpc: "2.0", error: { code: -32000, message: "Session not found." }, id: null }); return; }
    if (session.token !== token) { sendUnauthorized(res, config, "Token mismatch. Start a new session after re-authorization."); return; }
    session.lastActivity = Date.now();
    if (method === "POST") {
      let body: unknown;
      try { body = JSON.parse(await readBody(req)); }
      catch { sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }); return; }
      await session.transport.handleRequest(req, res, body);
    } else if (method === "GET" || method === "DELETE") {
      await session.transport.handleRequest(req, res);
    } else sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (method === "POST") {
    let body: unknown;
    try { body = JSON.parse(await readBody(req)); }
    catch { sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }); return; }
    if (!isInitializeRequest(body)) {
      sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session ID and not an initialization request." }, id: null }); return;
    }

    if (!reserveInitialization(sessions, token)) {
      sendJson(res, 429, {
        error: "Too many active MCP sessions. Close an existing session and try again.",
      });
      return;
    }

    try {
      const api = new ApiClient(token, config.uprateBaseUrl);
      if (!(await validateToken(api, res, config))) return;

      const mcpServer = createUprateServer(api);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id): void => {
          sessions.active.set(id, { server: mcpServer, transport, token, lastActivity: Date.now() });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.active.delete(transport.sessionId);
      };
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } finally {
      releaseInitialization(sessions, token);
    }
    return;
  }
  sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: Missing session ID." }, id: null });
}
