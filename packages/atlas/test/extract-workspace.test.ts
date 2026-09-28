import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {assert} from '../../../test/assert.js';
import {extractWorkspace} from '../src/extract-workspace.js';
import {BUNDLE_INCLUDES, WORKSPACE_DEPENDS} from '../src/model.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

test('extracts this workspace as a build-order graph', async () => {
  const snapshot = await extractWorkspace(repoRoot);
  const ids = new Set(snapshot.nodes.map((node) => node.id));
  const edge = (relation: string, from: string, to: string) =>
    snapshot.edges.some(
      (item) => item.relation === relation && item.from === from && item.to === to,
    );

  assert(ids.has('grafyx-data-structures'), 'data-structures should be a node');
  assert(ids.has('grafyx-graph'), 'graph should be a node');
  assert(ids.has('grafyx-reactive'), 'reactive should be a node');
  assert(ids.has('grafyx-integrations'), 'integrations should be a node');
  assert(ids.has('grafyx'), 'grafyx should be a node');
  assert(ids.has('grafyx-atlas'), 'atlas should be a node');
  assert(!ids.has('grafyx-workspace'), 'the private workspace root is not a package node');

  const grafyx = snapshot.nodes.find((node) => node.id === 'grafyx');
  assert(grafyx?.private === false, 'the published package is not private');
  assert(
    snapshot.nodes.find((node) => node.id === 'grafyx-graph')?.private === true,
    'internal packages stay private',
  );

  assert(
    edge(WORKSPACE_DEPENDS, 'grafyx-data-structures', 'grafyx-graph'),
    'graph waits on data-structures',
  );
  assert(
    edge(WORKSPACE_DEPENDS, 'grafyx-data-structures', 'grafyx-reactive'),
    'reactive waits on data-structures',
  );
  assert(
    edge(WORKSPACE_DEPENDS, 'grafyx-reactive', 'grafyx-integrations'),
    'integrations waits on reactive',
  );
  assert(edge(WORKSPACE_DEPENDS, 'grafyx', 'grafyx-atlas'), 'atlas waits on the published package');
  assert(
    !edge(WORKSPACE_DEPENDS, 'grafyx-graph', 'grafyx'),
    'grafyx has no npm dependency on graph',
  );

  assert(edge(BUNDLE_INCLUDES, 'grafyx-graph', 'grafyx'), 'grafyx re-exports graph');
  assert(edge(BUNDLE_INCLUDES, 'grafyx-reactive', 'grafyx'), 'grafyx re-exports reactive');
  assert(edge(BUNDLE_INCLUDES, 'grafyx-integrations', 'grafyx'), 'grafyx re-exports integrations');
  assert(
    !edge(BUNDLE_INCLUDES, 'grafyx-data-structures', 'grafyx'),
    'data-structures is not a direct re-export',
  );

  assert(snapshot.root === repoRoot, 'the snapshot records the scanned root');
  assert(snapshot.extractedAt.length > 0, 'the snapshot records when it was extracted');
});

test('discovers dependencies and re-exports in a temporary workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-workspace-'));

  try {
    await mkdir(join(root, 'packages/a'), {recursive: true});
    await mkdir(join(root, 'packages/b'), {recursive: true});
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({private: true, workspaces: ['packages/*']}),
    );
    await writeFile(
      join(root, 'packages/a/package.json'),
      JSON.stringify({name: 'pkg-a', version: '1.2.0', description: 'base', private: true}),
    );
    await writeFile(join(root, 'packages/a/index.ts'), 'export const value = 1;\n');
    await writeFile(
      join(root, 'packages/b/package.json'),
      JSON.stringify({
        name: 'pkg-b',
        version: '2.0.0',
        dependencies: {'pkg-a': '*', typescript: '*'},
      }),
    );
    await writeFile(join(root, 'packages/b/index.ts'), "export * from '../a/index.js';\n");

    const snapshot = await extractWorkspace(root);
    const depends = snapshot.edges.find((item) => item.relation === WORKSPACE_DEPENDS);
    const bundled = snapshot.edges.find((item) => item.relation === BUNDLE_INCLUDES);

    assert(
      snapshot.nodes.map((node) => node.id).join(',') === 'pkg-a,pkg-b',
      'both packages are nodes',
    );
    assert(depends?.from === 'pkg-a' && depends.to === 'pkg-b', 'the dependency points forward');
    assert(bundled?.from === 'pkg-a' && bundled.to === 'pkg-b', 'the re-export points forward');
    assert(
      snapshot.edges.every((item) => item.from !== 'typescript'),
      'registry dependencies are not workspace edges',
    );
    const pkgA = snapshot.nodes.find((node) => node.id === 'pkg-a');
    assert(pkgA?.measures?.length === 1, 'a package records its source files');
    assert(pkgA?.measures?.[0]?.path === 'index.ts', 'the measure path is inside the package');
    assert(pkgA?.measures?.[0]?.lines === 1, 'the measure counts lines');
    assert(snapshot.scan?.fileCount === 2, 'the scan counts source in every package');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('an empty workspace has no packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-empty-'));

  try {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({private: true, workspaces: ['packages/*']}),
    );
    const snapshot = await extractWorkspace(root);
    assert(snapshot.nodes.length === 0, 'a workspace glob with no packages yields no nodes');
    assert(snapshot.edges.length === 0, 'an empty workspace yields no edges');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('a missing root fails with the path', async () => {
  const missing = join(tmpdir(), 'atlas-missing-root');
  let failed = false;

  try {
    await extractWorkspace(missing);
  } catch (error) {
    failed = true;
    if (!(error instanceof Error)) throw new Error('scan failures are errors');
    assert(error.message.includes(missing), 'the failure names the root');
  }

  assert(failed, 'a missing root should throw');
});
