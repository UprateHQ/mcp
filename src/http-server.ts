// src/http-server.ts
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ApiClient } from "./api.js";
import { registerAppTools } from "./tools/apps.js";
import { registerReviewTools } from "./tools/reviews.js";
import { registerTopicTools } from "./tools/topics.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerWorkflowTools } from "./tools/workflows.js";
import {
  OAuthConfig,
  handleMetadata,
  handleAuthorize,
  handleCallback,
  handleRegistration,
  handleTokenExchange,
} from "./oauth-proxy.js";

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  apiClient: ApiClient;
  token: string;
  lastActivity: number;
}

const MAX_SESSIONS = 1000;
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function registerAllTools(server: McpServer, api: ApiClient): void {
  registerAppTools(server, api);
  registerReviewTools(server, api);
  registerTopicTools(server, api);
  registerAnalyticsTools(server, api);
  registerWorkflowTools(server, api);
}

function extractBearerToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
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

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  sendResponse(res, status, { "Content-Type": "application/json" }, JSON.stringify(data));
}

export function startHttpServer(config: OAuthConfig & { port: number }): void {
  const sessions = new Map<string, Session>();

  // Cleanup idle sessions
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (now - session.lastActivity > SESSION_IDLE_TIMEOUT_MS) {
        session.transport.close().catch(() => {});
        sessions.delete(sessionId);
        console.error(`Session ${sessionId} expired (idle timeout)`);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupInterval.unref();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    try {
      // OAuth routes
      if (method === "GET" && pathname === "/.well-known/oauth-authorization-server") {
        const result = handleMetadata(config);
        sendResponse(res, result.status, result.headers, result.body);
        return;
      }

      if (method === "GET" && pathname === "/oauth/authorize") {
        const result = handleAuthorize(url.searchParams, config);
        sendResponse(res, result.status, result.headers, result.body);
        return;
      }

      if (method === "GET" && pathname === "/oauth/callback") {
        const result = handleCallback(url.searchParams, config);
        sendResponse(res, result.status, result.headers, result.body);
        return;
      }

      if (method === "POST" && pathname === "/oauth/register") {
        const body = await readBody(req);
        const result = handleRegistration(body);
        sendResponse(res, result.status, result.headers, result.body);
        return;
      }

      if (method === "POST" && pathname === "/oauth/token") {
        const body = await readBody(req);
        const result = await handleTokenExchange(body, config);
        sendResponse(res, result.status, result.headers, result.body);
        return;
      }

      // MCP routes
      if (pathname === "/mcp") {
        await handleMcpRequest(req, res, sessions, config);
        return;
      }

      // 404 for everything else
      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      console.error("Unhandled error:", error);
      sendJson(res, 500, { error: "Internal server error" });
    }
  });

  server.listen(config.port, () => {
    console.error(`Uprate MCP server running on http://0.0.0.0:${config.port}`);
  });
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, Session>,
  config: OAuthConfig
): Promise<void> {
  const method = req.method ?? "GET";

  // Bearer token required for all /mcp requests
  const token = extractBearerToken(req);
  if (!token) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const rawSessionId = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

  // Existing session — look up and delegate
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      sendJson(res, 404, { jsonrpc: "2.0", error: { code: -32000, message: "Session not found." }, id: null });
      return;
    }

    // Token mismatch check
    if (session.token !== token) {
      sendJson(res, 401, { error: "Token mismatch. Start a new session after re-authorization." });
      return;
    }

    session.lastActivity = Date.now();

    if (method === "POST") {
      const body = await readBody(req);
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(body);
      } catch {
        sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
        return;
      }
      await session.transport.handleRequest(req, res, parsedBody);
    } else if (method === "GET" || method === "DELETE") {
      await session.transport.handleRequest(req, res);
    } else {
      sendJson(res, 405, { error: "Method not allowed" });
    }
    return;
  }

  // New session — only on POST with initialization request
  if (method === "POST") {
    if (sessions.size >= MAX_SESSIONS) {
      sendJson(res, 503, { error: "Too many active sessions. Try again later." });
      return;
    }

    const body = await readBody(req);
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body);
    } catch {
      sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
      return;
    }

    if (!isInitializeRequest(parsedBody)) {
      sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session ID and not an initialization request." }, id: null });
      return;
    }

    const apiClient = new ApiClient(token, config.uprateBaseUrl);
    const mcpServer = new McpServer({
      name: "uprate-mcp-server",
      version: "1.0.0",
    });
    registerAllTools(mcpServer, apiClient);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId: string) => {
        sessions.set(newSessionId, {
          server: mcpServer,
          transport,
          apiClient,
          token,
          lastActivity: Date.now(),
        });
        console.error(`Session created: ${newSessionId}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        console.error(`Session closed: ${transport.sessionId}`);
      }
    };

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
    return;
  }

  // GET or DELETE without session ID
  sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: Missing session ID." }, id: null });
}
