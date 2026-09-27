import {test} from 'node:test';
import {LENSES, atlasEdgeId, extractProject, isLens, parseCommand} from 'grafyx-atlas';
import {assert} from '../../../test/assert.js';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

test('the published entry exports the lenses and command parser', () => {
  assert(LENSES.join(',') === 'map,impact,upstream,cycles,order', 'the five lenses are public');
  assert(isLens('impact'), 'impact is a lens');
  assert(!isLens('zoom'), 'an unknown word is not a lens');
  assert(
    atlasEdgeId('imports', 'models', 'services') === 'imports:models:services',
    'edge ids are stable',
  );
  assert(parseCommand('  services IMPACT  ', ['services']).lens === 'impact', 'lens is case-blind');
  assert(
    parseCommand('serv', ['services', 'models']).packageId === 'services',
    'a unique prefix selects a part',
  );
  assert(
    parseCommand('s', ['services', 'models']).packageId === null,
    'an ambiguous prefix selects nothing',
  );
  assert(parseCommand('', ['services']).packageId === null, 'an empty command selects nothing');
});

test('extractProject maps this workspace from the public entry', async () => {
  const snapshot = await extractProject(repoRoot);
  assert(snapshot.kind === 'workspace', 'this repo is a package map');
  const ids = new Set(snapshot.nodes.map((node) => node.id));
  assert(ids.has('grafyx'), 'grafyx is a node');
  assert(ids.has('grafyx-atlas'), 'atlas is a node');
});
