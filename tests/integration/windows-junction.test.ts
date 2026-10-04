import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveProjectFile, readStableFile } from '../../src/security/paths.js';

test('Windows junction cannot expose a file outside the registered project', { skip: process.platform !== 'win32' }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'cpb-junction-'));
  const root = path.join(fixture, 'project');
  const outside = path.join(fixture, 'outside');
  const junction = path.join(root, 'linked');
  try {
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(outside, 'source.ts'), 'export const outside = true;\n');
    await symlink(outside, junction, 'junction');
    await assert.rejects(resolveProjectFile(root, 'linked/source.ts'), { code: 'CONTEXT_BLOCKED' });
    await assert.rejects(resolveProjectFile(root, 'linked/source.ts', true), { code: 'CONTEXT_BLOCKED' });
    await assert.rejects(readStableFile(path.join(root, 'linked', 'source.ts')), { code: 'CONTEXT_STALE' });
  } finally {
    await unlink(junction).catch(() => {});
    await rm(fixture, { recursive: true, force: true });
  }
});
