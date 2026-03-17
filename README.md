# Uprate MCP Server

Connect your [UprateHQ](https://upratehq.com) app reviews to AI assistants like Claude, Cursor, and any MCP-compatible client.

Browse reviews, reply to users, analyze sentiment, and track topics — all through natural language.

## Quick Start

The server supports two connection modes: **hosted** (recommended) and **local**.

### Option A: Hosted (OAuth — no token needed)

Connect directly to the hosted MCP server. Your AI client handles authentication via browser-based OAuth.

<details>
<summary><strong>Claude Desktop</strong></summary>

1. Go to **Settings** → **Connectors** → **Add Custom Connector**
2. Fill in:
   - **Name:** `Uprate`
   - **Remote MCP server URL:** `https://mcp.upratehq.com/mcp`
3. Click **Add**

Claude will open a browser window to sign in to UprateHQ and authorize access.
</details>

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add uprate --transport http https://mcp.upratehq.com/mcp
```
</details>

<details>
<summary><strong>Cursor</strong></summary>

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "uprate": {
      "url": "https://mcp.upratehq.com/mcp"
    }
  }
}
```
</details>

When you first connect, your AI client will open a browser window to sign in to UprateHQ and authorize access.

### Option B: Local (API token)

Run the server locally using a personal API token.

#### 1. Get your API token

Go to [Settings > API Keys](https://app.upratehq.com/settings/api-keys) and create a new token.

#### 2. Install and build

```bash
npm install
npm run build
```

#### 3. Connect to your AI client

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to `claude_desktop_config.json`:

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
</details>

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add uprate -- node /absolute/path/to/uprate-mcp/dist/index.js
```

Set the environment variable `UPRATE_API_TOKEN` before launching Claude Code.
</details>

<details>
<summary><strong>Cursor</strong></summary>

Add to `.cursor/mcp.json` in your project:

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
</details>

## What Can You Do With It?

Once connected, just ask your AI assistant things like:

- *"Show me the latest negative reviews"*
- *"What are users complaining about this week?"*
- *"Reply to the review from John saying we've fixed the bug"*
- *"Give me a breakdown of ratings by country"*
- *"How fast are we responding to reviews?"*

## Tools

### Apps
| Tool | Description |
|------|-------------|
| `list_apps` | List all accessible apps |
| `get_app` | Get app details by UUID |

### Reviews
| Tool | Description |
|------|-------------|
| `list_reviews` | List and filter reviews (platform, sentiment, rating, status, territory, date, topic, search) |
| `get_review` | Get a single review with its response and topics |
| `reply_to_review` | Reply to a review (creates a draft by default) |
| `resolve_review` | Mark a review as resolved |
| `unresolve_review` | Remove the resolved flag |

### Topics
| Tool | Description |
|------|-------------|
| `list_topics` | List topics sorted by mention count |
| `get_topic_reviews` | List reviews for a specific topic |

### Analytics
| Tool | Description |
|------|-------------|
| `get_analytics_summary` | Overview stats and 30-day trends |
| `get_analytics_platforms` | App Store vs Play Store breakdown |
| `get_response_times` | Response time trends and aging buckets |
| `get_territories` | Geographic distribution of reviews |

### Workflows
Composite tools that combine multiple API calls into a single request:

| Tool | Description |
|------|-------------|
| `get_app_overview` | App details + analytics + platform breakdown |
| `get_negative_reviews_needing_attention` | Unresolved negative reviews + related topics |
| `get_app_health_report` | Analytics + response times + territories |

## Configuration

### Hosted mode (HTTP transport)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TRANSPORT` | Yes | — | Set to `http` |
| `MCP_BASE_URL` | Yes | — | Public URL of the MCP server |
| `OAUTH_STATE_SECRET` | Yes | — | HMAC secret for OAuth state signing |
| `PORT` | No | `3000` | HTTP server port |
| `UPRATE_BASE_URL` | No | `https://app.upratehq.com` | Uprate backend URL |

### Local mode (stdio transport)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `UPRATE_API_TOKEN` | Yes | — | API token from UprateHQ |
| `UPRATE_BASE_URL` | No | `https://app.upratehq.com` | API base URL |

## Requirements

- Node.js 18+

## License

MIT
