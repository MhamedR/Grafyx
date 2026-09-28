import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {assert} from '../../../test/assert.js';
import {createMapServer} from '../src/map-server.js';
import {remove, sourceProject} from './fixture.js';

const require = createRequire(import.meta.url);
const atlasDist = dirname(require.resolve('grafyx-atlas'));
const ui = join(atlasDist, 'ui', 'app.js');

test('the map server is grafyx-atlas startAtlasServer', {skip: !existsSync(ui)}, async () => {
  const root = await sourceProject();
  const server = createMapServer(atlasDist);
  try {
    const started = await server.start(root, 0);
    const snapshot = (await (await fetch(`${started.url}/api/snapshot`)).json()) as {
      kind?: string;
      nodes: Array<{id: string}>;
    };
    const ids = snapshot.nodes.map((node) => node.id).sort();
    assert(snapshot.kind === 'source', 'the served map is the atlas snapshot');
    assert(ids.join(',') === 'models,services', 'the served parts match the fixture');

    const again = await server.start(root, 0);
    assert(again.url === started.url, 'the same root and port keeps the running server');
    assert((await server.stop()) === true, 'stop closes the server');
    assert((await server.stop()) === false, 'a second stop is a no-op');
  } finally {
    await server.stop();
    await remove(root);
  }
});
