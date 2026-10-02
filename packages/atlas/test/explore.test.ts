import {test} from 'node:test';
import {assert} from '../../../test/assert.js';
import {
  directRelations,
  locateByPath,
  matchesQuery,
  presentEdge,
  presentNode,
  searchNodes,
  visibleIds,
} from '../src/explore.js';
import type {AtlasSnapshot} from '../src/model.js';

const snapshot: AtlasSnapshot = {
  root: '/repo',
  extractedAt: '2026-01-01T00:00:00.000Z',
  kind: 'workspace',
  nodes: [
    {id: 'models', version: '1.0.0', private: true, path: 'src/models', description: 'records'},
    {
      id: 'services',
      version: '1.0.0',
      private: true,
      path: 'src/services',
      description: 'reads models',
      files: ['user-service.ts'],
    },
    {id: 'app', version: '1.0.0', private: true, path: 'src/app', description: ''},
    {id: 'extra', version: '1.0.0', private: true, path: 'src/extra', description: ''},
  ],
  edges: [
    {id: 'imports:models:services', from: 'models', to: 'services', relation: 'imports'},
    {id: 'imports:services:app', from: 'services', to: 'app', relation: 'imports'},
  ],
};

test('direct relations split what a node stands on from what requires it', () => {
  const relations = directRelations(snapshot.edges, 'services');
  assert(relations.dependencies.join() === 'models', 'services stands on models');
  assert(relations.dependents.join() === 'app', 'app requires services');
  assert(
    relations.dependencyEdges.join() === 'imports:models:services',
    'the incoming edge is kept',
  );
  assert(relations.dependentEdges.join() === 'imports:services:app', 'the outgoing edge is kept');
});

test('focus modes keep a neighborhood and otherwise leave the graph whole', () => {
  assert(visibleIds(snapshot, 'services', 'full') === null, 'full graph hides nothing');
  assert(visibleIds(snapshot, null, 'one') === null, 'a neighborhood needs a selection');

  const one = visibleIds(snapshot, 'services', 'one');
  assert(one?.has('services') === true, 'the selection stays');
  assert(one?.has('models') === true, 'one hop includes a dependency');
  assert(one?.has('app') === true, 'one hop includes a dependent');
  assert(one?.has('extra') === false, 'an unrelated node drops out');

  const dependencies = visibleIds(snapshot, 'app', 'dependencies');
  assert(dependencies?.has('models') === true, 'dependencies walk through the chain');
  assert(dependencies?.has('extra') === false, 'dependencies ignore outsiders');
  assert(
    visibleIds(snapshot, 'services', 'dependents')?.has('models') === false,
    'dependents do not walk backward',
  );
});

test('search ranks names above paths and still fuzzy-matches', () => {
  assert(
    matchesQuery(snapshot.nodes[1]!, 'user-service') === true,
    'a file name matches the filter',
  );
  assert(matchesQuery(snapshot.nodes[0]!, 'nope') === false, 'an unknown token does not match');

  const ranked = searchNodes(snapshot.nodes, 'serv');
  assert(ranked[0]?.id === 'services', 'a name prefix wins');
  const fuzzy = searchNodes(snapshot.nodes, 'srvcs');
  assert(
    fuzzy.some((hit) => hit.id === 'services'),
    'characters in order still find the node',
  );
  assert(searchNodes(snapshot.nodes, '   ').length === 0, 'a blank query has no hits');
});

test('a file path locates one node and refuses a tie', () => {
  assert(
    locateByPath(snapshot, '/repo/src/services/user-service.ts')?.id === 'services',
    'a file inside a part selects that part',
  );
  assert(
    locateByPath(snapshot, '/other/src/app.ts') === undefined,
    'a path outside the root is ignored',
  );
});

test('selection paints dependencies, dependents, and the rest differently', () => {
  assert(
    presentNode({
      selected: true,
      dependency: false,
      dependent: false,
      emphasized: true,
      lensScopes: false,
      filtered: true,
      hidden: false,
      hasSelection: true,
    }) === 'selected',
    'the selection stays readable when the filter misses it',
  );
  assert(
    presentNode({
      selected: false,
      dependency: true,
      dependent: false,
      emphasized: true,
      lensScopes: true,
      filtered: false,
      hidden: false,
      hasSelection: true,
    }) === 'dependency',
    'a direct dependency is not just another related node',
  );
  assert(
    presentNode({
      selected: false,
      dependency: false,
      dependent: false,
      emphasized: true,
      lensScopes: true,
      filtered: false,
      hidden: false,
      hasSelection: true,
    }) === 'related',
    'the rest of a lens cone stays visible but secondary',
  );
  assert(
    presentNode({
      selected: false,
      dependency: false,
      dependent: false,
      emphasized: true,
      lensScopes: false,
      filtered: false,
      hidden: false,
      hasSelection: true,
    }) === 'dimmed',
    'the map lens dims anything outside the neighborhood',
  );
  assert(
    presentEdge({
      dependency: false,
      dependent: true,
      emphasized: true,
      lensScopes: false,
      hasSelection: true,
      orderLens: true,
      hidden: false,
    }) === 'dependent',
    'a direct edge stays visible on the order lens',
  );
  assert(
    presentEdge({
      dependency: false,
      dependent: false,
      emphasized: true,
      lensScopes: false,
      hasSelection: false,
      orderLens: true,
      hidden: false,
    }) === 'quiet',
    'the order lens hides edges until something is selected',
  );
});
