# webshot-mcp

A remote MCP server that screenshots locally-built static sites without a local browser, Playwright installation, or public hosting of unreleased work.

Deployed to Cloudflare Workers with Browser Rendering, R2 content-addressed storage, and Streamable HTTP MCP.

## Live Deployment

- **Endpoint**: `https://webshot-mcp.bookis.workers.dev`
- **Transport**: Streamable HTTP / Server-Sent Events (MCP specification)
- **Account**: `bookis@worthysoftware.co`

---

## Architecture

```
  agent (local)                      Cloudflare
  ─────────────                      ──────────
  npx webshot sync ./dist  ──────►   POST /sync/plan     ─┐
                           ◄──────   { missing: [hash] }  │  R2: blobs/<sha256>
                           ──────►   PUT /sync/blob/<h>   │      sites/<id>/manifest.json
                           ──────►   POST /sync/commit   ─┘

  MCP client               ──────►   Worker (Streamable HTTP)
                                       │ tool: screenshot
                                       ▼
                                     Browser Rendering
                                       │ every request intercepted
                                       ▼
                                     R2 blobs  (no network, no origin server)
                           ◄──────   image + console errors + missing files
```

### Constraints Satisfied

1. **File bytes never pass through the model's context**: The sync happens out-of-band via the CLI. The model only receives structured tool results.
2. **Nothing is publicly addressable**: Pages are never served on a public URL. Puppeteer intercepts `https://webshot.local` requests directly and fulfills them from R2 blobs before DNS resolution.
3. **Local footprint stays trivial**: The local CLI is a zero-dependency Node script using only built-in modules (`node:crypto`, `node:fs`, `node:zlib`, `fetch`). No Chromium or Playwright on the developer machine.
4. **Repeat syncs are near-free**: Blobs are keyed by SHA-256 content hash. Only missing hashes are uploaded. Unchanged builds upload 0 bytes.

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
# Basic usage
node ./cli/bin/webshot.mjs sync ./dist

# Specify site ID and custom endpoint
node ./cli/bin/webshot.mjs sync ./dist --site my-site --endpoint https://webshot-mcp.bookis.workers.dev
```

### Environment Variables
- `WEBSHOT_ENDPOINT`: Default server URL (defaults to `https://webshot-mcp.bookis.workers.dev`).
- `WEBSHOT_SITE`: Custom stable site ID.
- `WEBSHOT_TOKEN`: Optional Bearer token if server authentication is enabled.

---

## MCP Client Configuration

### Claude Desktop / Cursor / Antigravity

Add to your MCP configuration (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "webshot": {
      "url": "https://webshot-mcp.bookis.workers.dev",
      "transport": "streamable-http"
    }
  }
}
```

Or using an SSE / HTTP proxy or direct client connection.

---

## Testing & Verification

Run the test suite:

```bash
npm test
```

Unit tests cover:
- Path resolution & MIME type mapping for Vite SPAs, Astro static builds, and Next.js static exports.
- Sync protocol endpoints (`/sync/plan`, `/sync/blob/:hash`, `/sync/commit`).
- MCP tools registration and Streamable HTTP JSON-RPC negotiation.
- CLI argument parsing and error handling.
