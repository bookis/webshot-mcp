import { describe, it, expect } from 'vitest';
import { resolvePath, getMimeType, listPages } from '../src/resolve.js';

describe('Resolver and MIME map', () => {
  describe('Vite SPA dist output', () => {
    const viteManifest: Record<string, string> = {
      'index.html': 'hash_index',
      'assets/main.4bd1a2b3.js': 'hash_js',
      'assets/style.7c8d9e0f.css': 'hash_css',
      'favicon.ico': 'hash_ico',
      'logo.svg': 'hash_svg'
    };

    it('resolves root index.html', () => {
      expect(resolvePath('/', viteManifest)).toBe('index.html');
      expect(resolvePath('', viteManifest)).toBe('index.html');
      expect(resolvePath('/index.html', viteManifest)).toBe('index.html');
    });

    it('resolves hashed assets', () => {
      expect(resolvePath('/assets/main.4bd1a2b3.js', viteManifest)).toBe('assets/main.4bd1a2b3.js');
      expect(resolvePath('/assets/style.7c8d9e0f.css', viteManifest)).toBe('assets/style.7c8d9e0f.css');
      expect(resolvePath('/favicon.ico', viteManifest)).toBe('favicon.ico');
      expect(resolvePath('/logo.svg', viteManifest)).toBe('logo.svg');
    });

    it('returns null for client-side routes (deferred to SPA fallback in render)', () => {
      expect(resolvePath('/pricing', viteManifest)).toBeNull();
      expect(resolvePath('/dashboard/settings', viteManifest)).toBeNull();
    });

    it('returns null for missing assets without matching HTML', () => {
      expect(resolvePath('/assets/missing.js', viteManifest)).toBeNull();
    });

    it('lists navigable pages', () => {
      expect(listPages(viteManifest)).toEqual(['/']);
    });
  });

  describe('Astro static dist output', () => {
    const astroManifest: Record<string, string> = {
      'index.html': 'hash_astro_index',
      'about/index.html': 'hash_astro_about',
      'blog/post-1/index.html': 'hash_astro_p1',
      'blog/post-2/index.html': 'hash_astro_p2',
      '_astro/hoisted.abc123.js': 'hash_astro_js',
      '_astro/style.def456.css': 'hash_astro_css',
      'robots.txt': 'hash_astro_robots'
    };

    it('resolves root', () => {
      expect(resolvePath('/', astroManifest)).toBe('index.html');
    });

    it('resolves directory routes with and without trailing slash', () => {
      expect(resolvePath('/about', astroManifest)).toBe('about/index.html');
      expect(resolvePath('/about/', astroManifest)).toBe('about/index.html');
      expect(resolvePath('/blog/post-1', astroManifest)).toBe('blog/post-1/index.html');
      expect(resolvePath('/blog/post-1/', astroManifest)).toBe('blog/post-1/index.html');
    });

    it('resolves static assets', () => {
      expect(resolvePath('/_astro/hoisted.abc123.js', astroManifest)).toBe('_astro/hoisted.abc123.js');
      expect(resolvePath('/robots.txt', astroManifest)).toBe('robots.txt');
    });

    it('lists navigable pages', () => {
      expect(listPages(astroManifest)).toEqual(['/', '/about', '/blog/post-1', '/blog/post-2']);
    });
  });

  describe('Next.js static export output (default and trailingSlash: true)', () => {
    const nextExportManifest: Record<string, string> = {
      'index.html': 'hash_next_index',
      'about.html': 'hash_next_about',
      'dashboard/settings.html': 'hash_next_settings',
      '404.html': 'hash_next_404',
      '_next/static/chunks/main-abc.js': 'hash_next_main_js',
      '_next/static/css/style-def.css': 'hash_next_style_css'
    };

    it('resolves root and HTML pages without .html suffix', () => {
      expect(resolvePath('/', nextExportManifest)).toBe('index.html');
      expect(resolvePath('/about', nextExportManifest)).toBe('about.html');
      expect(resolvePath('/about/', nextExportManifest)).toBe('about.html');
      expect(resolvePath('/about.html', nextExportManifest)).toBe('about.html');
      expect(resolvePath('/dashboard/settings', nextExportManifest)).toBe('dashboard/settings.html');
      expect(resolvePath('/dashboard/settings/', nextExportManifest)).toBe('dashboard/settings.html');
    });

    it('resolves next static assets', () => {
      expect(resolvePath('/_next/static/chunks/main-abc.js', nextExportManifest)).toBe('_next/static/chunks/main-abc.js');
      expect(resolvePath('/_next/static/css/style-def.css', nextExportManifest)).toBe('_next/static/css/style-def.css');
    });

    it('lists navigable pages', () => {
      expect(listPages(nextExportManifest)).toEqual(['/', '/404', '/about', '/dashboard/settings']);
    });
  });

  describe('MIME types mapping', () => {
    it('maps all expected static file extensions correctly', () => {
      expect(getMimeType('index.html')).toBe('text/html; charset=utf-8');
      expect(getMimeType('style.css')).toBe('text/css; charset=utf-8');
      expect(getMimeType('bundle.js')).toBe('application/javascript; charset=utf-8');
      expect(getMimeType('module.mjs')).toBe('application/javascript; charset=utf-8');
      expect(getMimeType('data.json')).toBe('application/json; charset=utf-8');
      expect(getMimeType('image.svg')).toBe('image/svg+xml');
      expect(getMimeType('photo.jpg')).toBe('image/jpeg');
      expect(getMimeType('photo.jpeg')).toBe('image/jpeg');
      expect(getMimeType('picture.png')).toBe('image/png');
      expect(getMimeType('picture.webp')).toBe('image/webp');
      expect(getMimeType('picture.avif')).toBe('image/avif');
      expect(getMimeType('favicon.ico')).toBe('image/x-icon');
      expect(getMimeType('font.woff2')).toBe('font/woff2');
      expect(getMimeType('robots.txt')).toBe('text/plain; charset=utf-8');
      expect(getMimeType('app.wasm')).toBe('application/wasm');
    });

    it('defaults unknown extensions to application/octet-stream', () => {
      expect(getMimeType('archive.xyz123')).toBe('application/octet-stream');
    });
  });
});
