import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiClient, handleToolError, jsonToolResult } from "../api.js";

export function registerSoulTools(server: McpServer, api: ApiClient): void {
  server.registerTool("get_review_soul", {
    title: "Get Review Soul",
    description: "Get the complete Review Soul for an app. Missing Soul data returns version: 0 and exists: false.",
    inputSchema: { app_uuid: z.string().uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ app_uuid }) => {
    try { return jsonToolResult(await api.get(`/apps/${app_uuid}/soul`)); }
    catch (error) { return handleToolError(error); }
  });

  server.registerTool("update_review_soul", {
    title: "Update Review Soul",
    description: "Replace the complete Review Soul for an app. This destructive write increments the Soul version.",
    inputSchema: {
      app_uuid: z.string().uuid(),
      content: z.string().max(10_000).describe("Complete Review Soul content (maximum 10,000 characters)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ app_uuid, content }) => {
    try { return jsonToolResult(await api.put(`/apps/${app_uuid}/soul`, { body: { content } })); }
    catch (error) { return handleToolError(error); }
  });
}
