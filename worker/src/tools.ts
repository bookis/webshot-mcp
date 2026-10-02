import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Env, renderPage, loadManifest } from './render.js';
import { listPages } from './resolve.js';

export function registerTools(server: McpServer, env: Env, userId: string = 'default') {
  // Tool 1: list_sites
  server.tool(
    'list_sites',
    'List all synced sites and their site IDs for the authenticated user. Use this first to discover available site IDs or verify that a sync succeeded.',
    {},
    async () => {
      try {
        const prefix = `users/${userId}/sites/`;
        const listed = await env.BLOBS.list({ prefix, delimiter: '/' });
        const siteIds: string[] = [];

        if (listed.delimitedPrefixes) {
          for (const p of listed.delimitedPrefixes) {
            const trimmed = p.replace(prefix, '').replace(/\/$/, '');
            if (trimmed) siteIds.push(trimmed);
          }
        }

        // Check legacy sites path for default/admin user
        if (siteIds.length === 0 && (userId === 'default' || userId === 'admin')) {
          const legacy = await env.BLOBS.list({ prefix: 'sites/', delimiter: '/' });
          if (legacy.delimitedPrefixes) {
            for (const p of legacy.delimitedPrefixes) {
              const trimmed = p.replace('sites/', '').replace(/\/$/, '');
              if (trimmed) siteIds.push(trimmed);
            }
          }
        }

        if (siteIds.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No sites have been synced yet for this account.\n\nTo sync a local project:\n1. Build your static project (e.g. 'npm run build').\n2. Run in terminal: 'npx webshot sync ./dist' (or your build directory, e.g. ./build, ./out).\n   Tip: You can pass a custom name: 'npx webshot sync ./dist --site my-site'\n3. The CLI outputs the siteId.\n4. Call this tool again or call 'screenshot' / 'list_pages' with that siteId.`
              }
            ]
          };
        }

        const lines = [
          `Synced sites (${siteIds.length} total):`,
          ...siteIds.map((s) => `  - ${s}`),
          '',
          'Next steps:',
          '- Run list_pages(siteId: "<siteId>") to discover available routes',
          '- Run screenshot(siteId: "<siteId>", path: "/") to capture a visual screenshot',
          '- Run "npx webshot sync <distDir>" in terminal to sync new or updated files'
        ];

        return {
          content: [
            {
              type: 'text',
              text: lines.join('\n')
            }
          ]
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Failed to list sites: ${(err as Error).message}`
            }
          ]
        };
      }
    }
  );

  // Tool 2: screenshot
  server.tool(
    'screenshot',
    'Capture a screenshot of any page on a synced site. Uses Cloudflare Browser Rendering with request interception to serve unreleased builds securely without an origin server. To use on a local project: build it (e.g. npm run build), run "npx webshot sync ./dist" in terminal, then call this tool with the returned siteId.',
    {
      siteId: z.string().describe('Stable site ID returned by running "npx webshot sync <distDir>" (e.g. site_a1b2c3 or custom name). Run "list_sites" to see existing synced sites, or run "npx webshot sync ./dist" in terminal to sync a local build.'),
      path: z.string().describe('Path to screenshot (e.g. / or /pricing or /about). Run list_pages(siteId) to discover valid paths.'),
      viewport: z.object({
        width: z.number().optional().describe('Viewport width in pixels (default: 1280)'),
        height: z.number().optional().describe('Viewport height in pixels (default: 800)'),
        deviceScaleFactor: z.number().optional().describe('Device pixel ratio (default: 1, set 2 for retina)')
      }).optional().describe('Optional viewport dimensions'),
      fullPage: z.boolean().optional().describe('Whether to screenshot full scrollable page (default: false)'),
      waitFor: z.union([z.string(), z.number()]).optional().describe('Selector string to wait for, or milliseconds delay'),
      format: z.enum(['jpeg', 'png']).optional().describe('Image format (default: jpeg; png is explicit opt-in)'),
      quality: z.number().min(1).max(100).optional().describe('JPEG quality between 1 and 100 (default: 85)'),
      allowedHosts: z.array(z.string()).optional().describe('Additional external hostnames to permit (e.g. cdn.example.com)')
    },
    async (params) => {
      try {
        const result = await renderPage(env, params.siteId, params.path, {
          viewport: params.viewport,
          fullPage: params.fullPage,
          waitFor: params.waitFor,
          format: params.format,
          quality: params.quality,
          allowedHosts: params.allowedHosts,
          userId
        }, userId);

        const lines: string[] = [
          `Page: ${params.path} (Title: "${result.pageTitle || 'Untitled'}")`,
          `Site: ${params.siteId}`
        ];

        if (result.missing.length > 0) {
          lines.push(`Missing files (${result.missing.length}):\n${result.missing.map((m) => `  - ${m}`).join('\n')}`);
        } else {
          lines.push('Missing files: none (all assets resolved)');
        }

        if (result.errors.length > 0) {
          lines.push(`Errors (${result.errors.length}):\n${result.errors.map((e) => `  - ${e}`).join('\n')}`);
        }

        if (result.console.length > 0) {
          lines.push(`Console logs (${result.console.length}):\n${result.console.map((c) => `  [${c.type}] ${c.text}`).join('\n')}`);
        }

        const content: any[] = [];

        if (result.screenshot) {
          content.push({
            type: 'image',
            data: result.screenshot.data,
            mimeType: result.screenshot.mimeType
          });
        }

        content.push({
          type: 'text',
          text: lines.join('\n\n')
        });

        return { content };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Screenshot error: ${(err as Error).message}`
            }
          ]
        };
      }
    }
  );

  // Tool 3: list_pages
  server.tool(
    'list_pages',
    'List all navigable page routes from the site manifest, allowing the agent to discover valid routes instead of guessing.',
    {
      siteId: z.string().describe('Stable site ID (e.g. site_a1b2c3). Call "list_sites" to see available sites, or run "npx webshot sync ./dist" in terminal to create a site.')
    },
    async ({ siteId }) => {
      try {
        const manifest = await loadManifest(env, siteId, userId);
        if (!manifest) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Site '${siteId}' not found for your account.\n\nTo sync this project:\n1. Build your static project (e.g. 'npm run build').\n2. In terminal, run: npx webshot sync ./dist --site ${siteId}\n3. Call 'list_sites' to view all your synced site IDs.`
              }
            ]
          };
        }

        const pages = listPages(manifest);
        if (pages.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Site '${siteId}' has ${Object.keys(manifest).length} synced files, but no HTML pages were found.`
              }
            ]
          };
        }

        const text = `Navigable pages for site '${siteId}' (${pages.length} total):\n${pages.map((p) => `  - ${p}`).join('\n')}`;
        return {
          content: [
            {
              type: 'text',
              text
            }
          ]
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Failed to list pages for site '${siteId}': ${(err as Error).message}`
            }
          ]
        };
      }
    }
  );

  // Tool 4: console_log
  server.tool(
    'console_log',
    'Diagnose JavaScript errors, runtime console output, and missing network requests for a page without rendering an image.',
    {
      siteId: z.string().describe('Stable site ID (e.g. site_a1b2c3). Call "list_sites" to see available sites, or run "npx webshot sync ./dist" in terminal.'),
      path: z.string().describe('Path to inspect (e.g. / or /pricing). Call list_pages(siteId) to discover valid paths.'),
      waitFor: z.union([z.string(), z.number()]).optional().describe('Selector string to wait for, or milliseconds delay'),
      allowedHosts: z.array(z.string()).optional().describe('Additional external hostnames to permit')
    },
    async (params) => {
      try {
        const result = await renderPage(env, params.siteId, params.path, {
          skipScreenshot: true,
          waitFor: params.waitFor,
          allowedHosts: params.allowedHosts,
          userId
        }, userId);

        const lines: string[] = [
          `Diagnostics for ${params.path} on site '${params.siteId}' (Title: "${result.pageTitle || 'Untitled'}")`,
          `Secure context: ${result.isSecureContext ? 'yes' : 'no'}`
        ];

        if (result.missing.length > 0) {
          lines.push(`Missing files (${result.missing.length}):\n${result.missing.map((m) => `  - ${m}`).join('\n')}`);
        } else {
          lines.push('Missing files: none (all assets resolved)');
        }

        if (result.errors.length > 0) {
          lines.push(`Page errors (${result.errors.length}):\n${result.errors.map((e) => `  - ${e}`).join('\n')}`);
        } else {
          lines.push('Page errors: none');
        }

        if (result.console.length > 0) {
          lines.push(`Console logs (${result.console.length}):\n${result.console.map((c) => `  [${c.type}] ${c.text}`).join('\n')}`);
        } else {
          lines.push('Console logs: none');
        }

        return {
          content: [
            {
              type: 'text',
              text: lines.join('\n\n')
            }
          ]
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Diagnostics error: ${(err as Error).message}`
            }
          ]
        };
      }
    }
  );
}
