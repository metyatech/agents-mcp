import { describe, test, expect } from 'bun:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { checkCliAvailable } from '../src/agents.js';

describe('CLI resolution', () => {
  test('checkCliAvailable resolves executables via PATH without external which/where noise', async () => {
    const tempDir = path.join(tmpdir(), `agents_mcp_path_${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    const baseName = 'cursor-agent';
    const fileName = process.platform === 'win32' ? `${baseName}.cmd` : baseName;
    const fullPath = path.join(tempDir, fileName);

    if (process.platform === 'win32') {
      await fs.writeFile(fullPath, '@echo off\r\necho hi\r\n', 'utf8');
    } else {
      await fs.writeFile(fullPath, '#!/bin/sh\necho hi\n', 'utf8');
      await fs.chmod(fullPath, 0o755);
    }

    const prevPath = process.env.PATH || '';
    process.env.PATH = `${tempDir}${path.delimiter}${prevPath}`;

    try {
      const [available, resolvedPath] = checkCliAvailable('cursor');
      expect(available).toBe(true);
      expect(resolvedPath).toBeTruthy();
      expect(resolvedPath!).toContain(tempDir);
    } finally {
      process.env.PATH = prevPath;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

