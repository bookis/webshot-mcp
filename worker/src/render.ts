import puppeteer, { Browser, Page } from '@cloudflare/puppeteer';
import { Buffer } from 'node:buffer';
import { getMimeType, resolvePath } from './resolve.js';

export interface Env {
  BROWSER: Fetcher;
  BLOBS: R2Bucket;
  MCP?: DurableObjectNamespace;
  AUTH_TOKEN?: string;
  JWT_SECRET?: string;
}

export interface ConsoleEntry {
  type: string;
  text: string;
}

export interface RenderOptions {
  viewport?: {
    width?: number;
    height?: number;
    deviceScaleFactor?: number;
  };
  fullPage?: boolean;
  waitFor?: string | number;
  format?: 'jpeg' | 'png';
  quality?: number;
  allowedHosts?: string[];
  skipScreenshot?: boolean;
  origin?: string; // default 'https://webshot.local'
  userId?: string;
}

export interface RenderResult {
  screenshot?: {
    data: string; // base64
    mimeType: 'image/jpeg' | 'image/png';
  };
  console: ConsoleEntry[];
  errors: string[];
  missing: string[];
  pageTitle: string;
  isSecureContext?: boolean;
}

const DEFAULT_ALLOWED_HOSTS = new Set([
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com'
]);

export async function loadManifest(
  env: Env,
  siteId: string,
  userId: string = 'default'
): Promise<Record<string, string> | null> {
  // Check user-scoped path first
  let manifestObj = await env.BLOBS.get(`users/${userId}/sites/${siteId}/manifest.json`);

  // Fallback to legacy root path for default user if not found
  if (!manifestObj && (userId === 'default' || userId === 'admin')) {
    manifestObj = await env.BLOBS.get(`sites/${siteId}/manifest.json`);
  }

  if (!manifestObj) {
    return null;
  }
  const text = await manifestObj.text();
  try {
    return JSON.parse(text) as Record<string, string>;
  } catch (err) {
    throw new Error(`Failed to parse manifest for site '${siteId}': ${(err as Error).message}`);
  }
}

export async function renderPage(
  env: Env,
  siteId: string,
  pathname: string,
  options: RenderOptions = {},
  userId: string = options.userId || 'default'
): Promise<RenderResult> {
  const manifest = await loadManifest(env, siteId, userId);
  if (!manifest) {
    throw new Error(`Site not found: manifest for site '${siteId}' does not exist.`);
  }

  const ORIGIN = options.origin || 'https://webshot.local';
  const blobs = new Map<string, ArrayBuffer>();
  const missing: string[] = [];
  const consoleEntries: ConsoleEntry[] = [];
  const errors: string[] = [];

  const allowedHosts = new Set([...DEFAULT_ALLOWED_HOSTS, ...(options.allowedHosts || [])]);

  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page: Page = await browser.newPage();

    const width = options.viewport?.width ?? 1280;
    const height = options.viewport?.height ?? 800;
    const deviceScaleFactor = options.viewport?.deviceScaleFactor ?? 1;

    await page.setViewport({
      width,
      height,
      deviceScaleFactor
    });

    page.on('console', (msg) => {
      consoleEntries.push({
        type: msg.type(),
        text: msg.text()
      });
    });

    page.on('pageerror', (err) => {
      errors.push(err instanceof Error ? err.message : String(err));
    });

    page.on('requestfailed', (req) => {
      const failure = req.failure();
      const url = req.url();
      if (!url.startsWith(ORIGIN)) {
        errors.push(`External request failed: ${url} (${failure?.errorText || 'unknown'})`);
      }
    });

    await page.setRequestInterception(true);

    page.on('request', async (req) => {
      let url: URL;
      try {
        url = new URL(req.url());
      } catch {
        return req.abort();
      }

      if (url.origin !== ORIGIN) {
        if (allowedHosts.has(url.host)) {
          return req.continue();
        }
        return req.abort();
      }

      let key = resolvePath(url.pathname, manifest);
      if (!key && req.isNavigationRequest() && manifest['index.html']) {
        key = 'index.html'; // SPA client-side routing fallback
      }

      if (!key) {
        missing.push(url.pathname);
        return req.respond({
          status: 404,
          contentType: 'text/plain',
          body: `File not found: ${url.pathname}`
        });
      }

      const hash = manifest[key];
      if (!hash) {
        missing.push(url.pathname);
        return req.respond({
          status: 404,
          contentType: 'text/plain',
          body: `Manifest entry missing hash: ${key}`
        });
      }

      let body = blobs.get(hash);
      if (!body) {
        const obj = await env.BLOBS.get(`blobs/${hash}`);
        if (!obj) {
          missing.push(url.pathname);
          return req.respond({
            status: 404,
            contentType: 'text/plain',
            body: `Blob content missing: ${hash}`
          });
        }
        body = await obj.arrayBuffer();
        blobs.set(hash, body);
      }

      const mimeType = getMimeType(key);
      return req.respond({
        status: 200,
        contentType: mimeType,
        body: Buffer.from(body)
      });
    });

    const targetUrl = `${ORIGIN}${pathname.startsWith('/') ? pathname : '/' + pathname}`;

    // Navigate to intercepted URL with timeout
    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: 25000
    });

    // Optional waitFor
    if (options.waitFor) {
      if (typeof options.waitFor === 'number') {
        await new Promise((resolve) => setTimeout(resolve, options.waitFor));
      } else if (typeof options.waitFor === 'string') {
        const numeric = Number(options.waitFor);
        if (!isNaN(numeric) && options.waitFor.trim() !== '') {
          await new Promise((resolve) => setTimeout(resolve, numeric));
        } else {
          await page.waitForSelector(options.waitFor, { timeout: 10000 });
        }
      }
    }

    const pageTitle = await page.title();
    let isSecureContext: boolean | undefined;
    try {
      isSecureContext = await page.evaluate(() => window.isSecureContext);
    } catch {
      // Ignore evaluation errors
    }

    const result: RenderResult = {
      console: consoleEntries,
      errors,
      missing,
      pageTitle,
      isSecureContext
    };

    if (!options.skipScreenshot) {
      const format = options.format === 'png' ? 'png' : 'jpeg';
      const screenshotBuffer = await page.screenshot({
        type: format,
        quality: format === 'jpeg' ? (options.quality ?? 85) : undefined,
        fullPage: options.fullPage ?? false,
        encoding: 'base64'
      });

      result.screenshot = {
        data: typeof screenshotBuffer === 'string' ? screenshotBuffer : Buffer.from(screenshotBuffer).toString('base64'),
        mimeType: format === 'png' ? 'image/png' : 'image/jpeg'
      };
    }

    return result;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
