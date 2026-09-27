import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {assert, ensure} from '../../../test/assert.js';
import {extractWorkspace} from '../src/extract-workspace.js';
import {layoutSnapshot} from '../src/layout.js';
import {atlasEdgeId, type AtlasSnapshot} from '../src/model.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function node(layout: ReturnType<typeof layoutSnapshot>, id: string) {
  return layout.nodes.find((item) => item.id === id);
}

test('this workspace ranks in build order', async () => {
  const snapshot = await extractWorkspace(repoRoot);
  const layout = layoutSnapshot(snapshot, {width: 1400, height: 800});
  const rank = (id: string) => node(layout, id)?.rank;

  assert(rank('grafyx-data-structures') === 0, 'data-structures is rank 0');
  assert(rank('grafyx-graph') === 1, 'graph is rank 1');
  assert(rank('grafyx-reactive') === 1, 'reactive shares rank 1');
  assert(rank('grafyx-integrations') === 2, 'integrations follows reactive');
  assert(rank('grafyx') === 3, 'the bundle follows everything it includes');
  assert(rank('grafyx-atlas') === 4, 'atlas follows grafyx');

  const dataStructures = node(layout, 'grafyx-data-structures');
  const graph = node(layout, 'grafyx-graph');
  const grafyx = node(layout, 'grafyx');
  ensure(
    dataStructures !== undefined && graph !== undefined && grafyx !== undefined,
    'nodes are placed',
  );
  assert(dataStructures.x < graph.x && graph.x < grafyx.x, 'earlier ranks sit to the left');
  assert(
    layout.edges.some((edge) => edge.relation === 'bundle-includes' && edge.cyclic === false),
    'bundle edges are drawn and are not cycles',
  );
});

test('strongly connected components collapse into one rank and flag cycle edges', () => {
  const snapshot: AtlasSnapshot = {
    root: '/cycle',
    extractedAt: '2026-09-25T00:00:00.000Z',
    nodes: ['a', 'b', 'c'].map((id) => ({
      id,
      version: '1.0.0',
      private: true,
      path: id,
      description: '',
    })),
    edges: (
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'b'],
      ] as const
    ).map(([from, to]) => ({
      id: atlasEdgeId('workspace-depends', from, to),
      from,
      to,
      relation: 'workspace-depends' as const,
    })),
  };
  const layout = layoutSnapshot(snapshot, {width: 900, height: 600});
  const rank = (id: string) => node(layout, id)?.rank ?? -1;

  assert(rank('a') === 0, 'the source stays rank 0');
  assert(rank('b') === rank('c') && rank('b') === 1, 'the cycle contracts to one rank');
  assert(
    layout.edges.find((edge) => edge.from === 'b' && edge.to === 'c')?.cyclic === true,
    'the forward cycle edge is flagged',
  );
  assert(
    layout.edges.find((edge) => edge.from === 'c' && edge.to === 'b')?.cyclic === true,
    'the return cycle edge is flagged',
  );
  assert(
    layout.edges.find((edge) => edge.from === 'a' && edge.to === 'b')?.cyclic === false,
    'the edge into the cycle is not itself cyclic',
  );
});
