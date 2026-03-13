import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiClient, handleToolError } from "../api.js";

export function registerTopicTools(server: McpServer, api: ApiClient): void {
  server.registerTool(
    "list_topics",
    {
      title: "List Topics",
      description:
        "List topics for an app, ordered by total mention count (descending). Returns topic UUID, slug, title, description, and mention counts broken down by sentiment.",
      inputSchema: {
        app_uuid: z.string().uuid().describe("The app UUID"),
        page: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Page number (default: 1)"),
        per_page: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Items per page (default: 25, max: 100)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ app_uuid, page, per_page }) => {
      try {
        const data = await api.get("/topics", {
          appUuid: app_uuid,
          query: { page, per_page },
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return handleToolError(error);
      }
    }
  );

  server.registerTool(
    "get_topic_reviews",
    {
      title: "Get Topic Reviews",
      description:
        "List reviews associated with a specific topic, ordered by review date (newest first). The topic must belong to the specified app.",
      inputSchema: {
        app_uuid: z.string().uuid().describe("The app UUID"),
        topic_uuid: z.string().uuid().describe("The topic UUID"),
        page: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Page number (default: 1)"),
        per_page: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Items per page (default: 25, max: 100)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ app_uuid, topic_uuid, page, per_page }) => {
      try {
        const data = await api.get(`/topics/${topic_uuid}/reviews`, {
          appUuid: app_uuid,
          query: { page, per_page },
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return handleToolError(error);
      }
    }
  );
}
