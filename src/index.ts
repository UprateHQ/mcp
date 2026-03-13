#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApiClient } from "./api.js";
import { registerAppTools } from "./tools/apps.js";
import { registerReviewTools } from "./tools/reviews.js";
import { registerTopicTools } from "./tools/topics.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerWorkflowTools } from "./tools/workflows.js";
import { startHttpServer } from "./http-server.js";

const transport = process.env.TRANSPORT ?? "stdio";
if (transport !== "stdio" && transport !== "http") {
  console.error(`ERROR: TRANSPORT must be "stdio" or "http", got "${transport}".`);
  process.exit(1);
}

const baseUrl = process.env.UPRATE_BASE_URL ?? "https://app.upratehq.com";

if (transport === "http") {
  const mcpBaseUrl = process.env.MCP_BASE_URL;
  if (!mcpBaseUrl) {
    console.error("ERROR: MCP_BASE_URL is required in HTTP mode.");
    process.exit(1);
  }

  const oauthStateSecret = process.env.OAUTH_STATE_SECRET;
  if (!oauthStateSecret) {
    console.error("ERROR: OAUTH_STATE_SECRET is required in HTTP mode.");
    process.exit(1);
  }

  const port = parseInt(process.env.PORT ?? "3000", 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error("ERROR: PORT must be a valid port number (1-65535).");
    process.exit(1);
  }

  startHttpServer({
    mcpBaseUrl,
    uprateBaseUrl: baseUrl,
    oauthStateSecret,
    port,
  });
} else {
  const token = process.env.UPRATE_API_TOKEN;
  if (!token) {
    console.error(
      "ERROR: UPRATE_API_TOKEN environment variable is required. " +
        "Create a token at /settings/api-keys in the Uprate web UI."
    );
    process.exit(1);
  }

  const api = new ApiClient(token, baseUrl);

  const server = new McpServer({
    name: "uprate-mcp-server",
    version: "1.0.0",
  });

  registerAppTools(server, api);
  registerReviewTools(server, api);
  registerTopicTools(server, api);
  registerAnalyticsTools(server, api);
  registerWorkflowTools(server, api);

  const stdioTransport = new StdioServerTransport();
  server.connect(stdioTransport).then(() => {
    console.error("Uprate MCP server running via stdio");
  }).catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
