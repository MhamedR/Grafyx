import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {assert, ensure} from '../../../test/assert.js';
import {extractWorkspace} from '../src/extract-workspace.js';
import {createAtlasSession, parseCommand} from '../src/session.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

test('the session derives impact, upstream, and a stable layout', async () => {
  const snapshot = await extractWorkspace(repoRoot);
  const session = createAtlasSession({
    root: snapshot.root,
    snapshot,
    viewport: {width: 1400, height: 800},
  });

  try {
    const structure = session.graph.value;
    assert(structure !== null, 'the graph is built from the snapshot');
    const again = session.graph.value;
    assert(again === structure, 'the graph computed is cached');

    session.runtime.batch(() => {
      session.selectedId.value = 'grafyx-data-structures';
      session.lens.value = 'impact';
    });

    assert(session.graph.value === structure, 'selection does not rebuild the graph');
    const impact = new Set(session.downstream.value);
    assert(impact.has('grafyx-graph'), 'impact includes graph');
    assert(impact.has('grafyx-reactive'), 'impact includes reactive');
    assert(impact.has('grafyx-integrations'), 'impact includes integrations');

    const lit = new Set(session.emphasis.value.nodes);
    assert(lit.has('grafyx-graph'), 'the impact lens lights graph');
    assert(lit.has('grafyx-reactive'), 'the impact lens lights reactive');
    assert(lit.has('grafyx-integrations'), 'the impact lens lights integrations');

    session.runtime.batch(() => {
      session.selectedId.value = 'grafyx-integrations';
      session.lens.value = 'upstream';
    });

    const ancestors = new Set(session.upstream.value);
    assert(ancestors.has('grafyx-reactive'), 'integrations stands on reactive');
    assert(ancestors.has('grafyx-data-structures'), 'integrations stands on data-structures');
    assert(!ancestors.has('grafyx'), 'grafyx is not upstream of integrations');

    session.setLens('cycles');
    assert(session.order.value.kind === 'order', 'this workspace has a build order');
    assert(session.emphasis.value.nodes.length === 0, 'the cycles lens lights nothing here');
    assert(
      session.components.value.length === snapshot.nodes.length,
      'each package is its own component',
    );

    const layout = session.layout.value;
    session.setQuery('graph');
    assert(session.layout.value === layout, 'a filter does not move the layout');

    const graphNode = layout?.nodes.find((node) => node.id === 'grafyx-graph');
    ensure(graphNode !== undefined, 'graph is placed');
    session.moveNode('grafyx-graph', 48, -16);
    const dragged = session.layout.value?.nodes.find((node) => node.id === 'grafyx-graph');
    ensure(dragged !== undefined, 'the dragged node stays in the picture');
    assert(
      dragged.x === graphNode.x + 48 && dragged.y === graphNode.y - 16,
      'a drag shifts the node',
    );
    assert(dragged.rank === graphNode.rank, 'a drag keeps the build rank');
    const draggedLayout = session.layout.value;
    assert(session.layout.value === draggedLayout, 'the dragged picture is cached');
    assert(session.graph.value === structure, 'a drag does not rebuild the graph');
    assert(draggedLayout?.ranks === layout?.ranks, 'rank bands stay while a node moves');

    session.setViewport({width: 1000, height: 700});
    assert(session.layout.value !== layout, 'viewport size recomputes the layout');

    assert(
      parseCommand('grafyx-graph impact', ['grafyx-graph']).packageId === 'grafyx-graph',
      'command reads a package',
    );
    assert(
      parseCommand('grafyx-graph impact', ['grafyx-graph']).lens === 'impact',
      'command reads a lens',
    );
  } finally {
    session.dispose();
  }
});
