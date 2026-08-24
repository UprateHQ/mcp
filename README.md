# Uprate MCP Server

Connect [UprateHQ](https://upratehq.com) app reviews to Codex, Claude, Cursor, and other MCP clients. The server exposes 23 tools for reviews, analytics, automation rules, Review Soul guidance, and composite workflows.

## Quick start

### Codex CLI — hosted OAuth

```bash
codex mcp add uprate --url https://mcp.upratehq.com/mcp
codex mcp login uprate
codex mcp get uprate
```

`codex mcp login` opens UprateHQ in a browser. After authorization, `codex mcp get uprate` shows the saved hosted-server configuration.

### Codex CLI — local stdio

Build this repository, then add the local server with a personal API token:

```bash
npm install
npm run build
codex mcp add uprate --env UPRATE_API_TOKEN=your-token-here -- node /absolute/path/to/uprate-mcp/dist/index.js
codex mcp get uprate
```

Create tokens at [Settings > API Keys](https://app.upratehq.com/settings/api-keys). The token is passed only to the stdio process through `UPRATE_API_TOKEN`.

### Claude Code

Hosted OAuth:

```bash
claude mcp add uprate --transport http https://mcp.upratehq.com/mcp
```

Claude Code should open a browser for UprateHQ login when it first connects. For a local server, set `UPRATE_API_TOKEN` in the environment that launches Claude Code, then run:

```bash
claude mcp add uprate -- node /absolute/path/to/uprate-mcp/dist/index.js
```

### Claude Desktop and Cursor

For hosted use, add `https://mcp.upratehq.com/mcp` as a custom remote MCP server. For local use, configure a command entry like this:

```json
{
  "mcpServers": {
    "uprate": {
      "command": "node",
      "args": ["/absolute/path/to/uprate-mcp/dist/index.js"],
      "env": {
        "UPRATE_API_TOKEN": "your-token-here"
      }
    }
  }
}
```

## Safe review replies

`reply_to_review` defaults `draft` to `true`, which is deliberately safer than relying on the API's omitted-field default. Read the review and its Review Soul before drafting. Publish only when the user explicitly asks for a live reply.

Draft-first example:

> Use `get_review_reply_context` for this review, write a response that follows the Review Soul, and save it as a draft.

When publication is explicitly requested, set `draft=false` and check that the returned `data.is_published` is exactly `true`. A successful HTTP response can still contain a preserved draft if store publication failed; the MCP tool surfaces that outcome as an error without discarding the draft data.

Reply limits are 5,970 characters for App Store, 350 for Google Play, and an upstream fallback of 2,000 when the platform is unknown.

## Tools

### Apps

| Tool | Description |
|---|---|
| `list_apps` | List accessible apps; use this to resolve an ambiguous app name to `app_uuid` |
| `get_app` | Get one app by UUID |

### Reviews

| Tool | Description |
|---|---|
| `list_reviews` | Filter reviews by platform, sentiment, rating, status, territory, date, topic, or text |
| `get_review` | Get one review with its response and topics |
| `reply_to_review` | Save a draft by default or explicitly request publication |
| `resolve_review` | Mark a review manually resolved |
| `unresolve_review` | Remove the manual resolved flag |

### Topics and analytics

| Tool | Description |
|---|---|
| `list_topics` | List topics by mention count |
| `get_topic_reviews` | List reviews associated with a topic |
| `get_analytics_summary` | Get overview metrics and 30-day trends |
| `get_analytics_platforms` | Compare App Store and Google Play metrics |
| `get_response_times` | Get response-time trends and aging buckets |
| `get_territories` | Get geographic review distribution |

### Automation rules

| Tool | Description |
|---|---|
| `list_automation_rules` | List automation rules |
| `create_automation_rule` | Create an app-specific or global rule |
| `toggle_automation_rule` | Invert a rule's enabled state; the call is non-idempotent |
| `delete_automation_rule` | Permanently delete a rule |

Automation rules guide Uprate workflows. They are not a security boundary that prevents a direct MCP publication request.

### Review Soul

| Tool | Description |
|---|---|
| `get_review_soul` | Read the complete Review Soul; missing data reports `version: 0`, `exists: false` |
| `update_review_soul` | Replace the complete Review Soul, up to 10,000 characters, and increment its version |

### Composite workflows

Each workflow counts every upstream request against the API limit.

| Tool | Uprate API requests | Description |
|---|---:|---|
| `get_app_overview` | 3 | App details, analytics summary, and platform breakdown |
| `get_negative_reviews_needing_attention` | 2 | Unresolved negative reviews and topics |
| `get_app_health_report` | 3 | Analytics, response times, and territories |
| `get_review_reply_context` | 2 | Review and Review Soul, fetched concurrently |

## Rate limit

Authenticated Uprate API access is limited to 300 requests per minute. Individual tools normally use one request; the composite counts are listed above. On a 429 response, wait for the `Retry-After` duration when supplied before retrying.

## Configuration

Hosted HTTP mode:

| Variable | Required | Default | Description |
|---|---|---|---|
| `TRANSPORT` | Yes | — | Set to `http` |
| `MCP_BASE_URL` | Yes | — | Public MCP server origin |
| `OAUTH_STATE_SECRET` | Yes | — | Stable random secret of at least 32 bytes, unique to this deployment environment, used to sign OAuth clients, state, and authorization codes |
| `OAUTH_ALLOWED_REDIRECT_URIS` | No | Built-in Claude and Cursor callbacks | Comma-separated additional exact callback URIs; wildcards are rejected |
| `OAUTH_UPSTREAM_CLIENT_ID` | No | `uprate-mcp-server` | Client ID registered by the Uprate backend for this proxy |
| `PORT` | No | `3000` | HTTP listen port |
| `UPRATE_BASE_URL` | No | `https://app.upratehq.com` | Uprate backend origin |

Local stdio mode:

| Variable | Required | Default | Description |
|---|---|---|---|
| `UPRATE_API_TOKEN` | Yes | — | Personal Uprate API token |
| `UPRATE_BASE_URL` | No | `https://app.upratehq.com` | Uprate backend origin |

## Troubleshooting

- OAuth login loops or stale credentials: log out of the MCP server in the client, then run the client's login flow again (`codex mcp login uprate` for Codex).
- Changing `OAUTH_STATE_SECRET` invalidates dynamically registered clients and in-flight authorization. Keep it stable; after an intentional rotation, re-register and reauthorize clients.
- Never reuse `OAUTH_STATE_SECRET` between development and production. Signed client, state, and code payloads do not cross an environment boundary safely when both environments share the signing key.
- Authentication fails after previously working: the OAuth credential or personal token may have expired or been revoked. Reauthorize or create a new API token.
- An app is missing: call `list_apps` and use the returned `app_uuid`. The credential may not have access to that app.
- A review or Soul request reports not found or forbidden: verify the app scope, object UUID, and account ownership. Review calls must use the owning app's `app_uuid`.
- A requested publication remains a draft: inspect the preserved response data and store connection; do not claim publication unless `data.is_published` is `true`.
- A request returns 429: stop issuing calls and wait for `Retry-After`, if present. Composite workflows consume two or three requests each.

## Development

Requires Node.js 20 or newer.

```bash
npm install
npm test
```

`npm test` builds TypeScript and runs the Node test suite.

## License

MIT
