import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {assert} from '../../../test/assert.js';
import {measureText, measureTree, scanFrom} from '../src/measure.js';
import type {PackageNode} from '../src/model.js';

test('measureText counts bytes and lines', () => {
  assert(measureText('').lines === 0, 'empty text has no lines');
  assert(measureText('a\n').lines === 1, 'a trailing newline is not an extra line');
  assert(measureText('a\nb').lines === 2, 'a line without a trailing newline still counts');
});

test('scanFrom ignores nodes that were not measured', () => {
  const measured: PackageNode = {
    id: 'a.ts',
    version: '',
    private: false,
    path: 'a.ts',
    description: '',
    measures: [{path: 'a.ts', bytes: 2, lines: 1}],
  };
  const bare: PackageNode = {
    id: 'empty',
    version: '',
    private: false,
    path: 'empty',
    description: '',
  };

  const scan = scanFrom(performance.now() + 10_000, [measured, bare]);

  assert(scan.fileCount === 1, 'only measured files count');
  assert(scan.byteCount === 2, 'bytes come from the measure');
  assert(scan.durationMs === 0, 'a clock skew does not produce a negative duration');
});

test('measureTree skips generated, hidden, and declaration files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-measure-'));

  try {
    await mkdir(join(root, 'src'), {recursive: true});
    await mkdir(join(root, 'node_modules/pkg'), {recursive: true});
    await mkdir(join(root, '.hidden'), {recursive: true});
    await mkdir(join(root, 'dist'), {recursive: true});
    await mkdir(join(root, 'coverage'), {recursive: true});
    await writeFile(join(root, 'src/a.ts'), 'a\n');
    await writeFile(join(root, 'src/b.ts'), 'no newline');
    await writeFile(join(root, 'src/skip.txt'), 'no');
    await writeFile(join(root, 'src/types.d.ts'), 'export type T = string;\n');
    await writeFile(join(root, 'node_modules/pkg/index.ts'), 'x');
    await writeFile(join(root, '.hidden/secret.ts'), 'x');
    await writeFile(join(root, 'dist/out.js'), 'x');
    await writeFile(join(root, 'coverage/out.js'), 'x');

    const measured = await measureTree(root);
    const missing = await measureTree(join(root, 'missing'));

    assert(
      measured.map((file) => file.path).join(',') === 'src/a.ts,src/b.ts',
      'only source files are measured',
    );
    assert(measured[0]?.lines === 1, 'a trailing newline is one line');
    assert(measured[1]?.lines === 1, 'a file without a trailing newline is one line');
    assert(missing.length === 0, 'a missing directory measures nothing');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
