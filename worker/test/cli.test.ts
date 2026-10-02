import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

describe('webshot CLI', () => {
  const cliPath = path.resolve(__dirname, '../../cli/bin/webshot.mjs');

  it('prints help message with -h or --help', () => {
    const out = execSync(`node "${cliPath}" --help`).toString();
    expect(out).toContain('webshot - upload local static builds to webshot-mcp');
    expect(out).toContain('webshot sync <distDir> [options]');
  });

  it('errors when dist directory does not exist', () => {
    expect(() => {
      execSync(`node "${cliPath}" sync /non-existent-dir-12345 2>&1`);
    }).toThrow();
  });

  it('errors when dist directory is empty', () => {
    const emptyDir = '/tmp/test-empty-webshot-dir';
    if (!fs.existsSync(emptyDir)) fs.mkdirSync(emptyDir, { recursive: true });
    expect(() => {
      execSync(`node "${cliPath}" sync "${emptyDir}" 2>&1`);
    }).toThrow(/empty/);
  });
});
