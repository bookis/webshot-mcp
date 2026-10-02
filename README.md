# webshot-mcp

A remote MCP server that screenshots locally-built static sites without a local browser, Playwright installation, or public hosting of unreleased work.

Deployed to Cloudflare Workers with Browser Rendering, R2 content-addressed storage, and Streamable HTTP MCP.

## Live Deployment

- **Endpoint**: `https://webshot.app`
- **Transport**: Streamable HTTP / Server-Sent Events (MCP specification)

---

## Architecture & Multi-Tenant Security

```
  agent (local)                      Cloudflare
  ─────────────                      ──────────
  npx webshot sync ./dist  ──────►   POST /sync/plan     ─┐
                           ◄──────   { missing: [hash] }  │  R2: blobs/<sha256> (global dedupe)
                           ──────►   PUT /sync/blob/<h>   │      users/<userId>/sites/<id>/manifest.json
                           ──────►   POST /sync/commit   ─┘

  MCP client               ──────►   Worker (Streamable HTTP)
                                       │ tool: screenshot (scoped to userId)
                                       ▼
                                     Browser Rendering
                                       │ every request intercepted
                                       ▼
                                     R2 blobs  (no network, no origin server)
                           ◄──────   image + console errors + missing files
```

### Multi-Tenant Isolation & Zero Trust
- **User Scoping**: Every user receives a cryptographically signed HMAC-SHA256 JWT containing a unique `userId` (`usr_...`).
- **Private Manifests**: Site file lists are saved under `users/<userId>/sites/<siteId>/manifest.json`. User A cannot view, query, or overwrite User B's sites.
- **Global Blob Deduplication**: File contents are stored by SHA-256 hash in `blobs/<hash>`. Common assets (e.g. React bundles, fonts) deduplicate globally across all users without leaking file paths or site structures.
- **No Public URLs**: Headless Chrome navigates internally to `https://webshot.local`. Requests are intercepted before DNS/TLS and fulfilled in-memory.

---

## Public User Registration

Anyone can register instantly with zero friction:

### Via CLI:
```bash
# Register and save token to ~/.webshot/config.json automatically
node ./cli/bin/webshot.mjs register

# Or simply run sync directly (auto-registers on first run if needed)
node ./cli/bin/webshot.mjs sync ./dist
```

### Via HTTP API:
```bash
curl -X POST https://webshot.app/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice"}'
```

Response:
```json
{
  "success": true,
  "userId": "usr_b836f1f4584c4841",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6...",
  "endpoint": "https://webshot.app"
}
```

---

## Tools Provided

### 1. `screenshot(siteId, path, viewport?, fullPage?, waitFor?, format?, quality?, allowedHosts?)`
Captures an image of any page on a synced site.
- **Defaults**: JPEG, 1280x800 viewport, `deviceScaleFactor: 1`, `fullPage: false`.
- **Surfaces**: Image block + Page Title + Missing files list (`missing[]`) + Page errors (`errors[]`) + Console logs (`console[]`).

### 2. `list_pages(siteId)`
Derives navigable page routes from the site's manifest (e.g. `/`, `/about`, `/blog/post-1`), allowing agents to discover existing routes instead of guessing.

### 3. `console_log(siteId, path, waitFor?, allowedHosts?)`
Navigates to the page and returns JavaScript runtime console logs, page errors, and failed network requests without capturing an image, for lightweight diagnosing.

---

## Local CLI: `webshot`

Upload your built `dist/` directory:

```bash
# Basic usage (uses credentials saved in ~/.webshot/config.json)
node ./cli/bin/webshot.mjs sync ./dist

# Specify site ID and custom token
node ./cli/bin/webshot.mjs sync ./dist --site my-site --token <token>
```

### Environment Variables
- `WEBSHOT_ENDPOINT`: Default server URL (defaults to `https://webshot.app`).
- `WEBSHOT_SITE`: Custom stable site ID.
- `WEBSHOT_TOKEN`: Bearer token / JWT (overrides `~/.webshot/config.json`).

---

## MCP Client Configuration

### Claude Desktop / Cursor / Antigravity

Configure your client to include your scoped token:

```json
{
  "mcpServers": {
    "webshot": {
      "url": "https://webshot.app/?token=YOUR_JWT_TOKEN",
      "transport": "streamable-http"
    }
  }
}
```

Or pass via headers:
```json
{
  "mcpServers": {
    "webshot": {
      "url": "https://webshot.app",
      "transport": "streamable-http",
      "headers": {
        "Authorization": "Bearer YOUR_JWT_TOKEN"
      }
    }
  }
}
```

---

## Testing & Verification

Run the test suite:

```bash
npm test
```

Unit tests cover:
- Path resolution & MIME type mapping for Vite SPAs, Astro static builds, and Next.js static exports.
- Sync protocol endpoints (`/sync/plan`, `/sync/blob/:hash`, `/sync/commit`).
- WebCrypto JWT signing, verification, tampering rejection, and user scoping.
- MCP tools registration and Streamable HTTP JSON-RPC negotiation.
- CLI argument parsing, registration, and error handling.
