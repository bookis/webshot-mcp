export const MIME_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  wasm: 'application/wasm'
};

export function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const mime = MIME_TYPES[ext];
  if (!mime) {
    console.warn(`[resolve] Unknown MIME type for extension '.${ext}' in '${filePath}', defaulting to application/octet-stream`);
    return 'application/octet-stream';
  }
  return mime;
}

/**
 * Path resolution per PLAN.md:
 * 1. exact match p
 * 2. trailing slash /index.html: p + 'index.html' or p + '/index.html'
 * 3. .html extension: p + '.html' (or strip trailing slash before adding .html)
 */
export function resolvePath(pathname: string, manifest: Record<string, string>): string | null {
  const p = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (p === '') {
    if (manifest['index.html']) return 'index.html';
  }

  // 1. Direct match (e.g., assets/app.js, about.html, favicon.ico)
  if (manifest[p]) return p;

  // 2. Trailing slash directory index (e.g. /blog/ -> blog/index.html)
  if (manifest[p + 'index.html']) return p + 'index.html';

  // 3. Directory without trailing slash (e.g. /blog -> blog/index.html)
  if (manifest[p + '/index.html']) return p + '/index.html';

  // 4. HTML extension (e.g. /about -> about.html)
  if (manifest[p + '.html']) return p + '.html';

  // 5. If p has trailing slash and matches a .html file (e.g. /about/ -> about.html)
  if (p.endsWith('/')) {
    const stripped = p.slice(0, -1);
    if (manifest[stripped + '.html']) return stripped + '.html';
  }

  return null;
}

/**
 * Derives user-navigable routes from the manifest so agents can discover pages.
 */
export function listPages(manifest: Record<string, string>): string[] {
  const pages = new Set<string>();

  for (const key of Object.keys(manifest)) {
    if (!key.endsWith('.html') && !key.endsWith('.htm')) {
      continue;
    }

    // Root index.html
    if (key === 'index.html' || key === 'index.htm') {
      pages.add('/');
      continue;
    }

    // Subdirectory index.html: e.g. blog/index.html -> /blog
    if (key.endsWith('/index.html')) {
      const route = '/' + key.slice(0, -'/index.html'.length);
      pages.add(route);
      continue;
    }
    if (key.endsWith('/index.htm')) {
      const route = '/' + key.slice(0, -'/index.htm'.length);
      pages.add(route);
      continue;
    }

    // Direct HTML file: e.g. about.html -> /about
    // Skip error pages if desired, or keep them if they are pages
    const base = key.replace(/\.html?$/, '');
    pages.add('/' + base);
  }

  return Array.from(pages).sort();
}
