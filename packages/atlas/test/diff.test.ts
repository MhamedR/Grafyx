import {test} from 'node:test';
import {assert} from '../../../test/assert.js';
import {diffSnapshots} from '../src/diff.js';
import {atlasEdgeId, type AtlasSnapshot, type PackageNode} from '../src/model.js';

function node(id: string, version = '1.0.0'): PackageNode {
  return {id, version, private: true, path: id, description: ''};
}

function snap(nodes: PackageNode[], edges: Array<[string, string]>): AtlasSnapshot {
  return {
    root: '/diff',
    extractedAt: '2026-09-25T00:00:00.000Z',
    nodes,
    edges: edges.map(([from, to]) => ({
      id: atlasEdgeId('workspace-depends', from, to),
      from,
      to,
      relation: 'workspace-depends',
    })),
  };
}

test('diff reports added, removed, and changed structure', () => {
  const before = snap([node('a'), node('b', '1.0.0')], [['a', 'b']]);
  const after = snap(
    [node('a'), {...node('b'), version: '1.1.0', description: 'changed'}, node('c')],
    [['a', 'c']],
  );
  const diff = diffSnapshots(before, after);

  assert(diff.addedNodes.map((item) => item.id).join(',') === 'c', 'new packages are added');
  assert(diff.removedNodes.length === 0, 'b is still present');
  assert(
    diff.changedNodes.map((item) => item.id).join(',') === 'b',
    'version changes are reported',
  );
  assert(diff.addedEdges.map((item) => item.to).join(',') === 'c', 'the new edge is added');
  assert(diff.removedEdges.map((item) => item.to).join(',') === 'b', 'the old edge is removed');
});

test('a change in file size is a changed node', () => {
  const before = snap([{...node('a'), measures: [{path: 'a.ts', bytes: 10, lines: 1}]}], []);
  const after = snap([{...node('a'), measures: [{path: 'a.ts', bytes: 40, lines: 3}]}], []);
  const diff = diffSnapshots(before, after);
  assert(diff.changedNodes.map((item) => item.id).join(',') === 'a', 'byte changes are reported');
});
