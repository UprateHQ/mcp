import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiClient, handleToolError } from "../api.js";

export function registerWorkflowTools(
  server: McpServer,
  api: ApiClient
): void {
  const readOnlyAnnotations = {
    readOnlyHint: true as const,
    destructiveHint: false as const,
    idempotentHint: true as const,
    openWorldHint: true as const,
  };

  server.registerTool(
    "get_app_overview",
    {
      title: "Get App Overview",
      description:
        "Get a comprehensive overview of an app by combining app details, analytics summary, and platform breakdown in a single call. Returns { app, analytics, platforms }.",
      inputSchema: {
        app_uuid: z.string().uuid().describe("The app UUID"),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ app_uuid }) => {
      try {
        const [app, analytics, platforms] = await Promise.all([
          api.get(`/apps/${app_uuid}`),
          api.get("/analytics/summary", { appUuid: app_uuid }),
          api.get("/analytics/platforms", { appUuid: app_uuid }),
        ]);
        const result = { app, analytics, platforms };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return handleToolError(error);
      }
    }
  );

  server.registerTool(
    "get_negative_reviews_needing_attention",
    {
      title: "Get Negative Reviews Needing Attention",
      description:
        "Get unresolved negative reviews alongside top topics for context. Helps prioritize which reviews to respond to. Returns { reviews, topics }.",
      inputSchema: {
        app_uuid: z.string().uuid().describe("The app UUID"),
        page: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Page number for reviews (default: 1)"),
        per_page: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Reviews per page (default: 25, max: 100)"),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ app_uuid, page, per_page }) => {
      try {
        const [reviews, topics] = await Promise.all([
          api.get("/reviews", {
            appUuid: app_uuid,
            query: {
              sentiments: ["negative"],
              status: "unresolved",
              sort: "newest",
              page,
              per_page,
            },
          }),
          api.get("/topics", {
            appUuid: app_uuid,
            query: { per_page: 100 },
          }),
        ]);
        const result = { reviews, topics };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return handleToolError(error);
      }
    }
  );

  server.registerTool(
    "get_app_health_report",
    {
      title: "Get App Health Report",
      description:
        "Get a consolidated health report combining analytics summary, response time trends with aging buckets, and geographic distribution. Useful for periodic check-ins. Returns { analytics, response_times, territories }.",
      inputSchema: {
        app_uuid: z.string().uuid().describe("The app UUID"),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ app_uuid }) => {
      try {
        const [analytics, response_times, territories] = await Promise.all([
          api.get("/analytics/summary", { appUuid: app_uuid }),
          api.get("/analytics/response-times", { appUuid: app_uuid }),
          api.get("/analytics/territories", { appUuid: app_uuid }),
        ]);
        const result = { analytics, response_times, territories };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return handleToolError(error);
      }
    }
  );
}
