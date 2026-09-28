import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import type {AtlasSnapshot, PackageNode} from 'grafyx-atlas';
import {assert} from '../../../test/assert.js';
import {
  decideRoot,
  filePathFromCommandArgument,
  findProjectRoot,
  nodeForFile,
  nodesForPath,
  relativeToRoot,
} from '../src/workspace.js';

test('a relative atlas root resolves from the workspace folder', () => {
  const decision = decideRoot({
    configuredRoot: 'src',
    folders: ['/proj'],
    targetPath: '/proj/lib/a.ts',
  });
  assert(decision.kind === 'root', 'a workspace file anchors a relative root');
  if (decision.kind !== 'root') return;
  assert(
    decision.root === resolve('/proj', 'src'),
    'the root is the workspace folder plus the setting',
  );
});

test('an absolute atlas root is used as written', () => {
  const decision = decideRoot({
    configuredRoot: '/elsewhere',
    folders: ['/proj'],
    targetPath: '/proj/a.ts',
  });
  assert(decision.kind === 'root' && decision.root === resolve('/elsewhere'), 'the setting wins');
});

test('a relative root without a workspace does not fall back to the working directory', () => {
  const decision = decideRoot({configuredRoot: 'src', folders: []});
  assert(decision.kind === 'error', 'there is nothing to resolve against');
  if (decision.kind !== 'error') return;
  assert(
    decision.message.includes('process working directory'),
    'the error says the working directory is not used',
  );
});

test('several workspace folders ask for a choice when no file picks one', () => {
  const decision = decideRoot({configuredRoot: '', folders: ['/a', '/b']});
  assert(
    decision.kind === 'choose' && decision.folders.join() === '/a,/b',
    'both folders are offered',
  );
});

test('a file inside one root of a multi-root workspace selects that root', () => {
  const decision = decideRoot({
    configuredRoot: '',
    folders: ['/a', '/a/nested', '/b'],
    targetPath: '/a/nested/src/app.ts',
  });
  assert(
    decision.kind === 'root' && decision.root === '/a/nested',
    'the longest containing folder wins',
  );
});

test('a file outside every workspace folder is mapped from its own tree', () => {
  const decision = decideRoot({
    configuredRoot: '',
    folders: ['/workspace'],
    targetPath: '/other/app/src/index.ts',
  });
  assert(
    decision.kind === 'walk' && decision.start === '/other/app/src/index.ts',
    'the outside file is the start',
  );
});

test('no folder and no file is an error', () => {
  const decision = decideRoot({configuredRoot: '', folders: []});
  assert(
    decision.kind === 'error' && decision.message.includes('Open a folder'),
    'the user must open a folder',
  );
});

test('the single open folder is the default root', () => {
  const decision = decideRoot({configuredRoot: '', folders: ['/only']});
  assert(decision.kind === 'root' && decision.root === '/only', 'one folder is --root');
});

test('windows paths stay inside their drive root', () => {
  assert(
    relativeToRoot('C:\\proj', 'C:\\proj\\src\\models\\user.ts') === 'src/models/user.ts',
    'a file under the root is relative and posix',
  );
  assert(
    relativeToRoot('C:\\proj', 'C:\\other\\a.ts') === undefined,
    'another directory is outside',
  );
  assert(
    relativeToRoot('C:\\proj', 'C:\\proj-extra\\a.ts') === undefined,
    'a prefix of the name is outside',
  );
  assert(
    relativeToRoot('C:\\Proj', 'c:\\proj\\Src\\A.ts') === 'Src/A.ts',
    'drive paths compare regardless of case',
  );
});

test('the longest node path owns a file, including a root package', () => {
  const snapshot: AtlasSnapshot = {
    root: 'C:\\repo',
    kind: 'workspace',
    extractedAt: '2026-01-01T00:00:00.000Z',
    edges: [],
    nodes: [
      node('root-pkg', '.'),
      node('grafyx', 'packages/grafyx'),
      node('models-extra', 'src/models-extra'),
    ],
  };
  assert(
    nodeForFile(snapshot, 'C:\\repo\\packages\\grafyx\\index.ts')?.id === 'grafyx',
    'the package wins over .',
  );
  assert(
    nodeForFile(snapshot, 'C:\\repo\\README.md')?.id === 'root-pkg',
    'a root file stays on the root package',
  );

  const source: AtlasSnapshot = {
    ...snapshot,
    root: '/app',
    kind: 'source',
    nodes: [node('models', 'src/models'), node('models-extra', 'src/models-extra')],
  };
  assert(
    nodeForFile(source, '/app/src/models/user.ts')?.id === 'models',
    'models does not swallow models-extra',
  );
  assert(
    nodeForFile(source, '/app/src/models-extra/a.ts')?.id === 'models-extra',
    'the longer folder matches',
  );
});

test('the packages folder means the parts inside it', () => {
  const snapshot: AtlasSnapshot = {
    root: '/repo',
    kind: 'workspace',
    extractedAt: '2026-01-01T00:00:00.000Z',
    edges: [],
    nodes: [node('grafyx', 'packages/grafyx'), node('grafyx-atlas', 'packages/atlas')],
  };
  const ids = nodesForPath(snapshot, '/repo/packages')
    .map((item) => item.id)
    .sort();
  assert(ids.join() === 'grafyx,grafyx-atlas', 'both packages are offered');
  assert(nodeForFile(snapshot, '/repo/packages') === undefined, 'packages itself is not one part');
  assert(
    nodeForFile(snapshot, '/repo/packages/atlas/src/index.ts')?.id === 'grafyx-atlas',
    'a file inside a package still selects that package',
  );
});

test('command arguments accept an explorer URI or a text editor', () => {
  assert(
    filePathFromCommandArgument({scheme: 'file', fsPath: '/app/src/a.ts'}) === '/app/src/a.ts',
    'an explorer URI is a path',
  );
  assert(
    filePathFromCommandArgument({document: {uri: {scheme: 'file', fsPath: '/app/src/b.ts'}}}) ===
      '/app/src/b.ts',
    'an editor is a path',
  );
  assert(
    filePathFromCommandArgument({scheme: 'untitled', fsPath: ''}) === undefined,
    'untitled has no path',
  );
  assert(filePathFromCommandArgument('services') === undefined, 'a string is not a resource');
});

test('findProjectRoot stops at the nearest package.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-vscode-walk-'));
  try {
    await mkdir(join(root, 'pkg/src'), {recursive: true});
    await writeFile(join(root, 'pkg/package.json'), '{"name":"pkg"}');
    await writeFile(join(root, 'pkg/src/a.ts'), 'export const a = 1;\n');
    const found = await findProjectRoot(join(root, 'pkg/src/a.ts'));
    assert(found === resolve(root, 'pkg'), 'the manifest directory is the project root');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

function node(id: string, path: string): PackageNode {
  return {id, version: '1.0.0', private: false, path, description: ''};
}
