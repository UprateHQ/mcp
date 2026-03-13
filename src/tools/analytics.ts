import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiClient, handleToolError } from "../api.js";

export function registerAnalyticsTools(
  server: McpServer,
  api: ApiClient
): void {
  const appUuidSchema = {
    app_uuid: z.string().uuid().describe("The app UUID"),
  };

  const readOnlyAnnotations = {
    readOnlyHint: true as const,
    destructiveHint: false as const,
    idempotentHint: true as const,
    openWorldHint: true as const,
  };

  server.registerTool(
    "get_analytics_summary",
    {
      title: "Get Analytics Summary",
      description:
        "Get overview statistics for an app including total review count, average rating, sentiment distribution, response rate, pending reviews count, 30-day trends with comparisons, and monthly time series for reviews, ratings, response coverage, and response times.",
      inputSchema: appUuidSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ app_uuid }) => {
      try {
        const data = await api.get("/analytics/summary", {
          appUuid: app_uuid,
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
    "get_analytics_platforms",
    {
      title: "Get Analytics Platforms",
      description:
        "Get App Store vs Play Store breakdown with per-platform metrics: review count, share, average rating, sentiment distribution, response rate, pending negative count, 30-day volume with change percentage, and average response time.",
      inputSchema: appUuidSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ app_uuid }) => {
      try {
        const data = await api.get("/analytics/platforms", {
          appUuid: app_uuid,
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
    "get_response_times",
    {
      title: "Get Response Times",
      description:
        "Get response time daily trend and aging bucket distribution. Returns daily average response time in hours and a 3-bucket breakdown (1-2 days, 3-14 days, 15+ days) showing how many unresponded reviews fall into each aging category.",
      inputSchema: appUuidSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ app_uuid }) => {
      try {
        const data = await api.get("/analytics/response-times", {
          appUuid: app_uuid,
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
    "get_territories",
    {
      title: "Get Territories",
      description:
        "Get geographic distribution of reviews. Returns top 8 territories by review count, with total reviews, average rating, and positive/negative sentiment share per territory.",
      inputSchema: appUuidSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ app_uuid }) => {
      try {
        const data = await api.get("/analytics/territories", {
          appUuid: app_uuid,
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
