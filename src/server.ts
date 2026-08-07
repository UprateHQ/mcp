import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiClient } from "./api.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerAppTools } from "./tools/apps.js";
import { registerAutomationRuleTools } from "./tools/automation-rules.js";
import { registerReviewTools } from "./tools/reviews.js";
import { registerSoulTools } from "./tools/soul.js";
import { registerTopicTools } from "./tools/topics.js";
import { registerWorkflowTools } from "./tools/workflows.js";

export const VERSION = "1.2.0";

export const SERVER_INSTRUCTIONS =
  "Resolve ambiguous app names with list_apps and use app_uuid for scoped calls. Read the review and its Review Soul before drafting a reply. Save replies as drafts by default; publish only when the user explicitly requests it, then verify data.is_published is true. The Uprate API limit is 300 requests per minute. Automation rules guide Uprate workflows but are not a security boundary for direct MCP publication.";

export function createUprateServer(api: ApiClient): McpServer {
  const server = new McpServer(
    { name: "uprate-mcp-server", version: VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );

  registerAppTools(server, api);
  registerReviewTools(server, api);
  registerTopicTools(server, api);
  registerAnalyticsTools(server, api);
  registerAutomationRuleTools(server, api);
  registerSoulTools(server, api);
  registerWorkflowTools(server, api);
  return server;
}
