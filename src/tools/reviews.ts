import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiClient, handleToolError, jsonToolResult } from "../api.js";

// Must stay a plain raw shape: the MCP SDK only serializes a ZodRawShape into
// the published JSON schema, so a wrapping .refine() would erase every property
// from tools/list. Cross-field checks live in the handler instead.
const listReviewsInput = {
  app_uuid: z.string().uuid().describe("The app UUID to scope reviews to"),
  platforms: z.array(z.enum(["app_store", "play_store"])).optional(),
  sentiments: z.array(z.enum(["positive", "neutral", "negative"])).optional(),
  rating_min: z.number().int().min(1).max(5).optional(),
  rating_max: z.number().int().min(1).max(5).optional(),
  status: z.enum([
    "unresolved", "resolved", "with_draft", "responded", "pending",
    "drafts", "flagged", "all",
  ]).optional(),
  territories: z.array(z.string()).optional(),
  date_from: z.string().date().optional().describe("Start date inclusive (YYYY-MM-DD)"),
  date_to: z.string().date().optional().describe("End date inclusive (YYYY-MM-DD)"),
  topic_uuid: z.string().uuid().optional(),
  search: z.string().max(255).optional(),
  sort: z.enum(["newest", "oldest", "highest", "lowest"]).optional(),
  page: z.number().int().min(1).optional(),
  per_page: z.number().int().min(1).max(100).optional(),
};

function listReviewsCrossFieldError(input: {
  date_from?: string;
  date_to?: string;
  rating_min?: number;
  rating_max?: number;
}): string | null {
  if (input.date_from && input.date_to && input.date_from > input.date_to) {
    return "date_from must be on or before date_to.";
  }
  if (
    input.rating_min !== undefined &&
    input.rating_max !== undefined &&
    input.rating_min > input.rating_max
  ) {
    return "rating_min must be less than or equal to rating_max.";
  }
  return null;
}

export function registerReviewTools(server: McpServer, api: ApiClient): void {
  server.registerTool("list_reviews", {
    title: "List Reviews",
    description: "List and filter reviews for an app by platform, sentiment, rating, status, territory, date, topic, or search.",
    inputSchema: listReviewsInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ app_uuid, platforms, sentiments, rating_min, rating_max, status, territories, date_from, date_to, topic_uuid, search, sort, page, per_page }) => {
    const crossFieldError = listReviewsCrossFieldError({ date_from, date_to, rating_min, rating_max });
    if (crossFieldError) {
      return { content: [{ type: "text" as const, text: crossFieldError }], isError: true as const };
    }
    try {
      return jsonToolResult(await api.get("/reviews", {
        appUuid: app_uuid,
        query: { platforms, sentiments, rating_min, rating_max, status, territories, date_from, date_to, topic_uuid, search, sort, page, per_page },
      }));
    } catch (error) { return handleToolError(error); }
  });

  server.registerTool("get_review", {
    title: "Get Review",
    description: "Get one review, including its response and topics. The review must belong to the specified app.",
    inputSchema: { app_uuid: z.string().uuid(), review_uuid: z.string().uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ app_uuid, review_uuid }) => {
    try { return jsonToolResult(await api.get(`/reviews/${review_uuid}`, { appUuid: app_uuid })); }
    catch (error) { return handleToolError(error); }
  });

  server.registerTool("reply_to_review", {
    title: "Reply to Review",
    description: "Reply to a review. draft=true is the safe MCP default even though the API's omitted-field default differs. Set draft=false only when publication is explicitly requested, then verify data.is_published. Limits: App Store 5,970 characters; Google Play 350; upstream fallback 2,000 when platform is unknown.",
    inputSchema: {
      app_uuid: z.string().uuid(),
      review_uuid: z.string().uuid(),
      content: z.string().min(10).max(5_970).describe("Reply text; the platform-specific upstream limit still applies"),
      draft: z.boolean().default(true).describe("true saves a draft (safe default); false requests live publication"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ app_uuid, review_uuid, content, draft }) => {
    try {
      const response = await api.post<Record<string, unknown>>(`/reviews/${review_uuid}/reply`, {
        appUuid: app_uuid,
        body: { content, draft },
      });
      const data = response.data as Record<string, unknown> | undefined;
      if (draft === false && data?.is_published !== true) {
        return {
          content: [{
            type: "text" as const,
            text: `PUBLICATION FAILED: Uprate preserved the reply as a draft. Verify the store connection and retry only with explicit approval.\n\n${JSON.stringify(response, null, 2)}`,
          }],
          structuredContent: response,
          isError: true as const,
        };
      }
      return jsonToolResult(response);
    } catch (error) { return handleToolError(error); }
  });

  server.registerTool("resolve_review", {
    title: "Resolve Review",
    description: "Mark a review as manually resolved.",
    inputSchema: { app_uuid: z.string().uuid(), review_uuid: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ app_uuid, review_uuid }) => {
    try { return jsonToolResult(await api.patch(`/reviews/${review_uuid}/resolve`, { appUuid: app_uuid })); }
    catch (error) { return handleToolError(error); }
  });

  server.registerTool("unresolve_review", {
    title: "Unresolve Review",
    description: "Remove the manual resolved flag. A published response can still make is_resolved true.",
    inputSchema: { app_uuid: z.string().uuid(), review_uuid: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ app_uuid, review_uuid }) => {
    try { return jsonToolResult(await api.patch(`/reviews/${review_uuid}/unresolve`, { appUuid: app_uuid })); }
    catch (error) { return handleToolError(error); }
  });
}
