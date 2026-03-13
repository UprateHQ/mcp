import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiClient, handleToolError } from "../api.js";

export function registerAppTools(server: McpServer, api: ApiClient): void {
  server.registerTool(
    "list_apps",
    {
      title: "List Apps",
      description:
        "List all apps accessible to the authenticated user. Returns paginated results with app UUID, name, platform, active status, and review count.",
      inputSchema: {
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
    async ({ page, per_page }) => {
      try {
        const data = await api.get("/apps", {
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
    "get_app",
    {
      title: "Get App",
      description:
        "Get details for a specific app by UUID. Returns app name, platform, active status, review count, and creation date.",
      inputSchema: {
        app_uuid: z.string().uuid().describe("The app UUID"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ app_uuid }) => {
      try {
        const data = await api.get(`/apps/${app_uuid}`);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return handleToolError(error);
      }
    }
  );
}
