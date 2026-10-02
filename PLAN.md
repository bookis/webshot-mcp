# webshot-mcp — Implementation Plan

A remote MCP server that screenshots locally-built static sites. The agent syncs a
`dist/` directory once, then requests screenshots of any page without running a
browser locally.

## Goal

Give a coding agent the ability to *look at* the site it just built, from any
machine, with no local browser, no Playwright install, and no public hosting of
unreleased work.

## Hard constraints

1. **File bytes must never pass through the model's context.** A `sync` MCP tool
   that accepts file contents as arguments would burn thousands of tokens per
   build and is disqualified. Sync happens out-of-band; the agent sees only a
   result line like `synced 3 files -> site_a1b2c3`.
2. **Nothing is publicly addressable.** Unreleased pages must not be fetchable by
   URL, even an unguessable one.
3. **Local footprint stays trivial.** The only thing installed locally is a
   zero-dependency Node script: hash, diff, PUT. No Chrome.
4. **Repeat syncs are near-free.** A rebuild that changes one component should
   upload one chunk, not the whole `dist/`.

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

Two deliverables: a Worker (the MCP server) and a tiny CLI (the uploader). They
share only the sync wire format.

## Component 1 — Remote MCP server (Worker)

| Concern | Choice |
|---|---|
| Transport | Streamable HTTP — `McpAgent` from the `agents` package |
| Screenshots | Browser Rendering, `@cloudflare/puppeteer` via the `browser` binding |
| Storage | R2, content-addressed |
| Auth | Bearer token header to start; Cloudflare Access if it needs sharing |
| State | Durable Object (required by `McpAgent`) |

### Tool surface

- `screenshot(siteId, path, viewport?, fullPage?, waitFor?)` → image, plus
  `console[]` and `missing[]`
- `list_pages(siteId)` → navigable paths from the manifest, so the agent
  discovers routes instead of guessing
- `console_log(siteId, path)` → JS errors and failed requests without the image,
  for when the agent only needs to diagnose

**Output defaults:** JPEG, 1280px wide, `fullPage: false`. A full-page retina PNG
of a long marketing page runs 2-3k tokens as base64 and is rarely needed. PNG and
retina are explicit opt-ins.

## Component 2 — Local uploader CLI

Zero dependencies, Node built-ins only (`node:crypto`, `node:fs`, `fetch`).
Published so it runs via `npx webshot sync ./dist`.

- `siteId` is stable per project (hash of repo path, or `--site` flag) so the
  blob cache survives across sessions.
- Uploads run 8-way parallel with `content-encoding: gzip`.
- Prints one line of output. That line is all the agent ever sees.

## Sync protocol

```
1. local   walk dist/, sha256 each file
           -> { "index.html": "9f2a…", "assets/app.4bd1.js": "c7e0…", … }
2. POST    /sync/plan    { siteId, manifest }
3. remote  check R2 for blobs/<hash>
           -> { missing: ["9f2a…"] }
4. PUT     /sync/blob/<hash>   (gzipped, parallel, only the missing ones)
5. POST    /sync/commit  { siteId, manifest }
           -> writes sites/<siteId>/manifest.json
```

Blobs are keyed by content hash, not path; the manifest is just a path→hash map.
Bundlers already emit hashed filenames, so after the first sync a typical rebuild
uploads `index.html` and maybe one chunk. One round trip plus the changed bytes.

Blobs are global (identical bytes dedupe across every site). Manifests are scoped
per `siteId` — one project must never be able to read another's file list.

## Serving: request interception

**No preview URL, no origin server, no public hosting.** Puppeteer's request
interception fires before DNS resolution, so we answer every request ourselves out
of R2. `https://webshot.local/pricing` never needs to exist or resolve, and
nothing leaves the browser process.

### Handler

```js
import puppeteer from '@cloudflare/puppeteer';

const ORIGIN = 'https://webshot.local';

const manifest = await loadManifest(env, siteId);
const blobs = new Map();   // hash -> bytes, held for the whole browser session
const missing = [];

const browser = await puppeteer.launch(env.BROWSER);
const page = await browser.newPage();

await page.setRequestInterception(true);
page.on('request', async (req) => {
  const url = new URL(req.url());

  if (url.origin !== ORIGIN) {
    return allowed(url.host) ? req.continue() : req.abort();
  }

  let key = resolve(url.pathname, manifest);
  if (!key && req.isNavigationRequest() && manifest['index.html']) {
    key = 'index.html';                       // SPA client-side routing
  }
  if (!key) {
    missing.push(url.pathname);
    return req.respond({ status: 404, contentType: 'text/plain', body: 'not found' });
  }

  const hash = manifest[key];
  let body = blobs.get(hash);
  if (!body) {
    body = await (await env.BLOBS.get(`blobs/${hash}`)).arrayBuffer();
    blobs.set(hash, body);
  }
  req.respond({ status: 200, contentType: mime(key), body: Buffer.from(body) });
});

await page.goto(ORIGIN + path, { waitUntil: 'networkidle2' });
```

### Path resolution

A static host does more path munging than people remember. Skip it and every
framework's output breaks differently:

```js
function resolve(pathname, manifest) {
  const p = decodeURIComponent(pathname).replace(/^\/+/, '');
  return manifest[p]                 ? p                 // /assets/app.4bd1.js
       : manifest[p + 'index.html']  ? p + 'index.html'  // /blog/   trailing slash
       : manifest[p + '/index.html'] ? p + '/index.html' // /blog
       : manifest[p + '.html']       ? p + '.html'       // /about -> about.html
       : null;
}
```

**The SPA fallback is gated on `isNavigationRequest()`, and must stay that way.**
Falling back to `index.html` for a missing *asset* hands the browser HTML where it
expected JavaScript, producing `Uncaught SyntaxError: Unexpected token '<'`
instead of a clean 404 that names the missing file.

Looking up in a manifest object rather than a filesystem makes path traversal
structurally impossible — `../../etc/passwd` is just a key that isn't in the map.

### MIME types

Not optional. JS served as `text/plain` is refused outright by strict MIME
checking, and the screenshot comes back as an unstyled skeleton with no console
error pointing at the cause. A ~15-entry extension map covers a built site:
`html css js mjs json svg png jpg webp avif woff2 ico`. Default to
`application/octet-stream` and log every hit on the default.

### External requests

Allowlist by host. The alternatives are both wrong for a tool whose job is visual
fidelity:

- abort everything → Google Fonts silently falls back to Times New Roman and the
  screenshot misrepresents the page
- allow everything → analytics beacons and long-polling sockets mean
  `networkidle0` may never fire

Ship an allowlist (fonts + the project's CDN), `networkidle2`, and a hard timeout.

### Free error reporting

Because every request funnels through one callback, `missing[]` costs nothing and
is the most useful thing the tool returns. A broken layout plus
`missing: ["/assets/hero.webp"]` is a fix the agent can act on immediately.
Pair with `page.on('console')` and `page.on('pageerror')`.

### Gotchas

- **Interception disables Chrome's HTTP cache.** Every request on every page hits
  the handler; the browser will not reuse the vendor bundle between `/` and
  `/pricing`. This is why `blobs` lives outside the page and is keyed by hash —
  shared bundles come out of R2 exactly once per session, however many pages are
  shot.
- **Use `https://` for the fake origin.** An `http://` origin on anything but
  localhost is not a secure context, so `crypto.subtle`, service workers, and the
  clipboard API are unavailable and some frameworks fail at boot. `fulfillRequest`
  short-circuits before the TLS handshake, so there is no certificate to validate.
  *Verify this specific behavior on Browser Rendering early — see open questions.*
- **`networkidle0` is the wrong default** once any external request is allowed.

## Repo layout

```
worker/
  src/index.ts        MCP server, Streamable HTTP + auth
  src/tools.ts        screenshot / list_pages / console_log
  src/render.ts       puppeteer + interception handler
  src/resolve.ts      path resolution + mime map
  src/sync.ts         /sync/plan, /sync/blob, /sync/commit
  wrangler.jsonc      browser binding, R2 binding, DO migration
cli/
  bin/webshot.mjs     walk, hash, diff, upload
PLAN.md
```

## Build order (Completed & Verified)

1. [x] **Render path first, hardcoded.** Proved interception works on Cloudflare Browser Rendering and confirmed `https://webshot.local` provides a valid secure context (`isSecureContext === true`).
2. [x] **Resolver + MIME map**, unit tested against real `dist/` output from a Vite SPA, an Astro static build, and a Next export. All passed in `resolve.test.ts`.
3. [x] **Sync endpoints + CLI.** Implemented `/sync/plan`, `/sync/blob/:hash`, and `/sync/commit`. Verified that a second sync of an unchanged build uploads zero bytes (`synced 0 files (3 unchanged)`).
4. [x] **Wrap as MCP.** Streamable HTTP transport with tools `screenshot`, `list_pages`, and `console_log`, HMAC-SHA256 JWT auth with user-scoped isolation, public self-registration (`/auth/register`), and optimized JPEG defaults.
5. [x] **Error surfacing.** `missing[]`, `console[]`, `errors[]` surfaced directly in tool results.

## Decisions already made

- Interception over a preview URL: satisfies constraint 2 and yields `missing[]`.
- Content-addressed blobs over per-site paths: satisfies constraint 4.
- Out-of-band CLI over an MCP sync tool: satisfies constraint 1.
- Cloudflare over a self-run container: Browser Rendering means never operating
  Chrome. Revisit only if interception proves unsupported there.

## Open questions & Empirical Findings

- **Does Browser Rendering support `setRequestInterception` with the full `Fetch.fulfillRequest` behavior, including for the initial navigation to a non-resolving host?**
  **Answered: YES.** Tested live on Cloudflare Browser Rendering. Puppeteer intercepts initial navigation to `https://webshot.local` before DNS resolution and fulfills with `index.html` and R2 blobs.
- **Does a fake `https://` origin reach secure-context status under interception?**
  **Answered: YES.** Verified live via `window.isSecureContext === true` on the rendered page.
- **Browser Rendering concurrency limits and per-session cost:**
  Launching a dedicated browser instance per render with immediate cleanup (`finally { browser.close() }`) ensures zero state leakage across requests. In-memory `blobs` map within the session prevents redundant R2 object fetches.
- **Blob garbage collection:**
  Unreferenced hashes accumulate safely due to global content-addressing and minimal R2 storage pricing. A scheduled Worker cron can periodically diff `blobs/*` keys against all `users/*/sites/*/manifest.json` files when cleanup is needed.
