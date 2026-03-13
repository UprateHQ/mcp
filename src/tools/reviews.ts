import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiClient, handleToolError } from "../api.js";

export function registerReviewTools(server: McpServer, api: ApiClient): void {
  server.registerTool(
    "list_reviews",
    {
      title: "List Reviews",
      description:
        "List and filter reviews for an app. Supports filtering by platform, sentiment, rating range, status, territory, date range, topic, and full-text search. Returns paginated results with review details, responses, and topics.",
      inputSchema: {
        app_uuid: z.string().uuid().describe("The app UUID to scope reviews to"),
        platforms: z
          .array(z.enum(["app_store", "play_store"]))
          .optional()
          .describe("Filter by platform"),
        sentiments: z
          .array(z.enum(["positive", "neutral", "negative"]))
          .optional()
          .describe("Filter by sentiment"),
        rating_min: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("Minimum rating (1-5)"),
        rating_max: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("Maximum rating (1-5)"),
        status: z
          .enum([
            "unresolved",
            "resolved",
            "with_draft",
            "responded",
            "pending",
            "drafts",
            "flagged",
            "all",
          ])
          .optional()
          .describe("Filter by review status"),
        territories: z
          .array(z.string())
          .optional()
          .describe("Filter by country codes (e.g. US, GB, DE)"),
        date_from: z
          .string()
          .optional()
          .describe("Start date inclusive (YYYY-MM-DD)"),
        date_to: z
          .string()
          .optional()
          .describe("End date inclusive (YYYY-MM-DD)"),
        topic_uuid: z
          .string()
          .uuid()
          .optional()
          .describe("Filter by topic UUID"),
        search: z
          .string()
          .max(255)
          .optional()
          .describe("Full-text search (max 255 characters)"),
        sort: z
          .enum(["newest", "oldest", "highest", "lowest"])
          .optional()
          .describe("Sort order (default: newest)"),
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
    async ({
      app_uuid,
      platforms,
      sentiments,
      rating_min,
      rating_max,
      status,
      territories,
      date_from,
      date_to,
      topic_uuid,
      search,
      sort,
      page,
      per_page,
    }) => {
      try {
        const data = await api.get("/reviews", {
          appUuid: app_uuid,
          query: {
            platforms,
            sentiments,
            rating_min,
            rating_max,
            status,
            territories,
            date_from,
            date_to,
            topic_uuid,
            search,
            sort,
            page,
            per_page,
          },
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
    "get_review",
    {
      title: "Get Review",
      description:
        "Get a single review by UUID, including its response and associated topics. The review must belong to the specified app.",
      inputSchema: {
        app_uuid: z.string().uuid().describe("The app UUID"),
        review_uuid: z.string().uuid().describe("The review UUID"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ app_uuid, review_uuid }) => {
      try {
        const data = await api.get(`/reviews/${review_uuid}`, {
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
    "reply_to_review",
    {
      title: "Reply to Review",
      description:
        "Reply to a review. By default saves as a draft (draft=true). Set draft=false to publish directly to the app store. Content must be at least 10 characters. Max length: 5970 chars (App Store) or 350 chars (Google Play). If the review already has a published response, returns a 409 error.",
      inputSchema: {
        app_uuid: z.string().uuid().describe("The app UUID"),
        review_uuid: z.string().uuid().describe("The review UUID to reply to"),
        content: z
          .string()
          .min(10)
          .describe(
            "Response text. Min 10 chars. Max 5970 (App Store) / 350 (Google Play)."
          ),
        draft: z
          .boolean()
          .default(true)
          .describe(
            "true = save as draft (default). false = publish to app store immediately."
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ app_uuid, review_uuid, content, draft }) => {
      try {
        const data = await api.post(`/reviews/${review_uuid}/reply`, {
          appUuid: app_uuid,
          body: { content, draft },
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
    "resolve_review",
    {
      title: "Resolve Review",
      description:
        "Mark a review as manually resolved. No request body needed. Returns the updated review.",
      inputSchema: {
        app_uuid: z.string().uuid().describe("The app UUID"),
        review_uuid: z.string().uuid().describe("The review UUID to resolve"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ app_uuid, review_uuid }) => {
      try {
        const data = await api.patch(`/reviews/${review_uuid}/resolve`, {
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
    "unresolve_review",
    {
      title: "Unresolve Review",
      description:
        "Remove the resolved flag from a review. Note: if the review has a published response, is_resolved will still be true (it is computed as has_response OR is_manually_resolved).",
      inputSchema: {
        app_uuid: z.string().uuid().describe("The app UUID"),
        review_uuid: z
          .string()
          .uuid()
          .describe("The review UUID to unresolve"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ app_uuid, review_uuid }) => {
      try {
        const data = await api.patch(`/reviews/${review_uuid}/unresolve`, {
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
