import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiClient, handleToolError, jsonToolResult } from "../api.js";

const condition = z.discriminatedUnion("type", [
  z.object({ type: z.literal("always") }).strict(),
  z.object({
    type: z.literal("schedule"),
    block_days: z.array(z.number().int().min(1).max(7)).nonempty(),
  }).strict(),
  z.object({
    type: z.literal("rating_filter"),
    ratings: z.array(z.number().int().min(1).max(5)).nonempty(),
  }).strict(),
  z.object({
    type: z.literal("keyword_filter"),
    keywords: z.array(z.string().max(50)).nonempty(),
  }).strict(),
]);

export function registerAutomationRuleTools(server: McpServer, api: ApiClient): void {
  server.registerTool("list_automation_rules", {
    title: "List Automation Rules",
    description: "List the authenticated user's automation rules.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    try { return jsonToolResult(await api.get("/automation-rules")); }
    catch (error) { return handleToolError(error); }
  });

  server.registerTool("create_automation_rule", {
    title: "Create Automation Rule",
    description: "Create an Uprate automation rule. Rules guide Uprate automation but are not a security boundary for direct MCP publication.",
    inputSchema: {
      app_uuid: z.string().uuid().nullable().optional(),
      scope: z.enum(["review.*", "review.publish_replies", "review.draft_replies", "market.*", "*"]),
      condition,
      action: z.enum(["block", "require_approval", "auto"]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ app_uuid, scope, condition, action }) => {
    try { return jsonToolResult(await api.post("/automation-rules", { body: { app_uuid, scope, condition, action } })); }
    catch (error) { return handleToolError(error); }
  });

  server.registerTool("toggle_automation_rule", {
    title: "Toggle Automation Rule",
    description: "Invert an automation rule's enabled state. Repeating this call reverses the previous change.",
    inputSchema: { rule_uuid: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ rule_uuid }) => {
    try { return jsonToolResult(await api.patch(`/automation-rules/${rule_uuid}/toggle`)); }
    catch (error) { return handleToolError(error); }
  });

  server.registerTool("delete_automation_rule", {
    title: "Delete Automation Rule",
    description: "Permanently delete an automation rule.",
    inputSchema: { rule_uuid: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ rule_uuid }) => {
    try { return jsonToolResult(await api.delete(`/automation-rules/${rule_uuid}`)); }
    catch (error) { return handleToolError(error); }
  });
}
