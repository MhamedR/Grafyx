import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {
  buildPackageGraph,
  cycles,
  downstream,
  extractProject,
  extractSourceFocus,
  type AtlasSnapshot,
} from 'grafyx-atlas';
import {assert, ensure} from '../../../test/assert.js';
import {ATLAS_COMMANDS} from '../src/commands.js';
import {createAtlasController, type AtlasControllerOptions} from '../src/controller.js';
import {cycleProject, remove, sourceProject} from './fixture.js';
import {fakeHost, fakeMap, settings, workspace, type FakeHost} from './fake.js';
import {filePathFromCommandArgument, type WorkspaceContext} from '../src/workspace.js';

test('activation registers every command and dispose releases the server', async () => {
  const host = fakeHost();
  const map = fakeMap();
  const controller = createAtlasController(options(host, map, workspace({folders: ['/proj']})));
  assert(
    host.commands.join() === ATLAS_COMMANDS.map((command) => command.id).join(),
    'activate registers each command',
  );

  await controller.run('grafyxAtlas.openMap');
  await controller.dispose();
  await controller.dispose();
  assert(map.stops === 1, 'dispose stops the map once');
  assert(host.cleared === 1, 'dispose clears diagnostics');
});

test('open map uses the setting port, not PORT, and opens a browser', async () => {
  const host = fakeHost();
  const map = fakeMap();
  const controller = createAtlasController(
    options(
      host,
      map,
      workspace({folders: ['/proj']}),
      settings({port: 4555, portExplicit: true, openIn: 'external'}),
      '1',
    ),
  );
  await controller.run('grafyxAtlas.openMap');
  assert(map.starts[0]?.port === 4555, 'an edited port is --port');
  assert(map.starts[0]?.root === '/proj', 'the workspace folder is the root');
  assert(host.opened[0] === 'http://127.0.0.1:4555', 'external is the CLI browser');
  assert(host.logs[0] === 'grafyx/atlas  http://127.0.0.1:4555', 'the log line matches the CLI');
  assert(host.logs[1] === '/proj', 'the resolved root is logged');
});

test('PORT is used when the port setting has not been edited', async () => {
  const host = fakeHost();
  const map = fakeMap();
  const controller = createAtlasController(
    options(host, map, workspace({folders: ['/proj']}), settings({openIn: 'none'}), '4500'),
  );
  await controller.run('grafyxAtlas.openMap');
  assert(map.starts[0]?.port === 4500, 'PORT is the CLI fallback');
  assert(host.opened.length === 0, 'none matches --no-open');
  assert(host.infos[0]?.includes('http://127.0.0.1:4500') === true, 'the URL is still shown');
});

test('open map shows the atlas page in an editor tab', async () => {
  const host = fakeHost();
  const map = fakeMap();
  const controller = createAtlasController(
    options(host, map, workspace({folders: ['/proj']}), settings({openIn: 'editor'})),
  );
  await controller.run('grafyxAtlas.openMap');
  assert(host.editor[0] === 'http://127.0.0.1:4328', 'the editor tab receives the map URL');
  assert(host.opened.length === 0, 'an external browser is not also opened');
});

test('a right-click on packages asks which part, then says what it stands on', async () => {
  const host = fakeHost();
  host.nextPick.push('grafyx-atlas');
  const snapshot: AtlasSnapshot = {
    root: '/repo',
    kind: 'workspace',
    extractedAt: '2026-01-01T00:00:00.000Z',
    edges: [
      {
        id: 'workspace-depends:grafyx:grafyx-atlas',
        from: 'grafyx',
        to: 'grafyx-atlas',
        relation: 'workspace-depends',
      },
    ],
    nodes: [
      {id: 'grafyx', version: '1.0.0', private: false, path: 'packages/grafyx', description: ''},
      {
        id: 'grafyx-atlas',
        version: '1.0.0',
        private: false,
        path: 'packages/atlas',
        description: '',
      },
    ],
  };
  const controller = createAtlasController({
    ...options(host, fakeMap(), workspace({folders: ['/repo'], targetPath: '/repo/packages'})),
    scan: async () => snapshot,
  });
  await controller.run('grafyxAtlas.showUpstream');
  assert(
    host.logs.some((line) => line.includes('No atlas part')) === false,
    'the packages folder is not reported as missing',
  );
  const notice = host.infos.join('\n');
  assert(notice.includes('grafyx-atlas'), 'the chosen part is named');
  assert(notice.includes('What this package stands on.'), 'the workspace question is kept');
  assert(notice.includes('grafyx'), 'grafyx-atlas stands on grafyx');
  const view = host.editor[0] ?? '';
  assert(view.includes('lens=upstream'), 'the map opens on upstream');
  assert(view.includes('id=grafyx-atlas'), 'the chosen part is selected on the map');
});

test('show impact calls downstream for the file under the cursor', async () => {
  const root = await sourceProject();
  try {
    const host = fakeHost();
    const controller = createAtlasController(options(host, fakeMap(), folder(root)));
    await controller.run('grafyxAtlas.showImpact', uri(join(root, 'src/models/user.ts')));

    const snapshot = await extractProject(root);
    const reached = downstream(buildPackageGraph(snapshot), 'models');
    const log = host.logs.join('\n');
    ensure(reached.includes('services'), 'services is downstream of models');
    for (const id of reached) assert(log.includes(id), `${id} is in the impact report`);
    assert(
      log.includes('What must change if this part changes.'),
      'the source lens question is kept',
    );
    assert(host.errors.length === 0, 'a successful scan is not an error');
    const view = host.editor[0] ?? '';
    assert(view.includes('lens=impact'), 'the map opens on impact');
    assert(view.includes('id=models'), 'models is selected on the map');
  } finally {
    await remove(root);
  }
});

test('show upstream accepts an editor argument', async () => {
  const root = await sourceProject();
  try {
    const host = fakeHost();
    const controller = createAtlasController(options(host, fakeMap(), folder(root)));
    await controller.run('grafyxAtlas.showUpstream', {
      document: {uri: {scheme: 'file', fsPath: join(root, 'src/services/auth.ts')}},
    });
    const log = host.logs.join('\n');
    assert(log.includes('services'), 'the editor file selects services');
    assert(log.includes('models'), 'services stands on models');
    assert(log.includes('What this part stands on.'), 'the upstream question is kept');
    const view = host.editor[0] ?? '';
    assert(view.includes('lens=upstream'), 'the map opens on upstream');
    assert(view.includes('id=services'), 'services is selected on the map');
  } finally {
    await remove(root);
  }
});

test('cycles become diagnostics and the cycle report', async () => {
  const root = await cycleProject();
  try {
    const host = fakeHost();
    const controller = createAtlasController(options(host, fakeMap(), folder(root)));
    await controller.run('grafyxAtlas.showCycles');
    const snapshot = await extractProject(root);
    const found = cycles(buildPackageGraph(snapshot));
    ensure(found.length > 0, 'the fixture has a cycle');
    const log = host.logs.join('\n');
    const published = host.diagnostics.at(-1) ?? [];
    for (const component of found) {
      for (const id of component) {
        assert(log.includes(id), `${id} is in the cycle report`);
        assert(
          published.some((item) => item.message.includes(id)),
          `${id} is in a diagnostic`,
        );
      }
    }
    assert(
      published.every((item) => item.file.length > 0),
      'each warning names a file',
    );
    assert(
      published.some((item) => item.file.endsWith('session.ts') || item.file.endsWith('user.ts')),
      'a warning sits on a file in the cycle',
    );
  } finally {
    await remove(root);
  }
});

test('diagnostics can be turned off', async () => {
  const root = await sourceProject();
  try {
    const host = fakeHost();
    const controller = createAtlasController(
      options(host, fakeMap(), folder(root), settings({diagnostics: false})),
    );
    await controller.run('grafyxAtlas.refreshDiagnostics');
    assert(host.diagnostics.length === 0, 'no warnings are published');
    assert(host.cleared === 1, 'existing warnings are cleared');
  } finally {
    await remove(root);
  }
});

test('go deeper calls extractSourceFocus', async () => {
  const root = await sourceProject();
  try {
    const host = fakeHost();
    const controller = createAtlasController(options(host, fakeMap(), folder(root)));
    await controller.run('grafyxAtlas.goDeeper', uri(join(root, 'src/services')));
    const focus = await extractSourceFocus(root, 'src/services');
    ensure(focus !== null, 'services opens');
    const log = host.logs.join('\n');
    for (const node of focus.nodes)
      assert(log.includes(node.id), `${node.id} is in the deeper map`);
  } finally {
    await remove(root);
  }
});

test('a part with nothing inside reports the server 404 text', async () => {
  const root = await sourceProject();
  try {
    const host = fakeHost();
    host.nextPick.push('models');
    const controller = createAtlasController(
      options(host, fakeMap(), workspace({folders: [root], dirtyPaths: []})),
    );
    await controller.run('grafyxAtlas.goDeeper');
    const focus = await extractSourceFocus(root, 'src/models');
    if (focus === null) {
      assert(host.infos.includes('Nothing deeper here.'), 'a null focus uses the server message');
    } else {
      assert(host.logs.join('\n').includes('user.ts'), 'the file inside models is shown');
    }
  } finally {
    await remove(root);
  }
});

test('run command uses parseCommand', async () => {
  const root = await sourceProject();
  try {
    const host = fakeHost();
    host.nextInput.push('serv impact');
    const controller = createAtlasController(options(host, fakeMap(), folder(root)));
    await controller.run('grafyxAtlas.runCommand');
    const log = host.logs.join('\n');
    assert(log.includes('services'), 'a unique prefix selects services');
    assert(log.includes('What must change if this part changes.'), 'impact is the lens');
  } finally {
    await remove(root);
  }
});

test('an unknown command word selects nothing', async () => {
  const root = await sourceProject();
  try {
    const host = fakeHost();
    host.nextInput.push('zzzz');
    const controller = createAtlasController(options(host, fakeMap(), folder(root)));
    await controller.run('grafyxAtlas.runCommand');
    assert(host.logs.includes('No matching part or lens.'), 'parseCommand found nothing');
    assert(host.errors.length === 0, 'a miss is not a crash');
  } finally {
    await remove(root);
  }
});

test('a missing project root keeps the atlas error', async () => {
  const missing = join(tmpdir(), `atlas-vscode-missing-${process.pid}`);
  let expected = '';
  try {
    await extractProject(missing);
  } catch (error) {
    expected = error instanceof Error ? error.message : String(error);
  }
  const host = fakeHost();
  const controller = createAtlasController(
    options(host, fakeMap(), workspace(), settings({root: missing})),
  );
  await controller.run('grafyxAtlas.showOrder');
  assert(host.errors[0] === expected, 'the extension shows the original message');
  assert(expected.includes(missing), 'the message names the path');
});

test('there is nothing to map without a folder or file', async () => {
  const host = fakeHost();
  const controller = createAtlasController(options(host, fakeMap(), workspace()));
  await controller.run('grafyxAtlas.showOrder');
  assert(host.errors[0]?.includes('Open a folder') === true, 'the missing workspace is explained');
});

test('a relative root is resolved from the chosen workspace folder', async () => {
  const seen: string[] = [];
  const host = fakeHost();
  host.nextPick.push('/b');
  const controller = createAtlasController({
    ...options(host, fakeMap(), workspace({folders: ['/a', '/b']}), settings({root: 'src'})),
    scan: async (root) => {
      seen.push(root);
      return emptySnapshot(root);
    },
  });
  await controller.run('grafyxAtlas.showOrder');
  assert(seen[0] === resolve('/b', 'src'), 'the picked folder anchors the relative root');
});

test('a file outside the workspace is scanned from its own package', async () => {
  const root = await sourceProject();
  try {
    const seen: string[] = [];
    const host = fakeHost();
    const controller = createAtlasController({
      ...options(host, fakeMap(), workspace({folders: ['/somewhere-else'], dirtyPaths: []})),
      readWorkspace: () =>
        workspace({
          folders: ['/somewhere-else'],
          dirtyPaths: [],
          targetPath: join(root, 'src/models/user.ts'),
        }),
      scan: async (scanned) => {
        seen.push(scanned);
        return extractProject(scanned);
      },
    });
    await controller.run('grafyxAtlas.showOrder');
    assert(resolve(seen[0] ?? '') === resolve(root), 'the package.json above the file is the root');
    assert(host.errors.length === 0, 'the outside file still scans');
  } finally {
    await remove(root);
  }
});

test('unsaved documents are named and the saved copy is still scanned', async () => {
  const root = await sourceProject();
  try {
    const host = fakeHost();
    const controller = createAtlasController(
      options(
        host,
        fakeMap(),
        workspace({
          folders: [root],
          dirtyPaths: [join(root, 'src/models/user.ts')],
          activeDocument: {
            fsPath: join(root, 'src/models/user.ts'),
            isDirty: true,
            isUntitled: false,
          },
        }),
      ),
    );
    await controller.run('grafyxAtlas.showOrder');
    assert(host.warnings[0]?.includes('user.ts') === true, 'the dirty file is named');
    assert(host.warnings[0]?.includes('saved copy') === true, 'the scan is the saved copy');
    assert(host.logs.join('\n').includes('models'), 'the saved project is still mapped');
    assert(host.errors.length === 0, 'a dirty file is not a failure');
  } finally {
    await remove(root);
  }
});

test('an untitled document is refused before a scan', async () => {
  const host = fakeHost();
  let scanned = false;
  const controller = createAtlasController({
    ...options(
      host,
      fakeMap(),
      workspace({
        activeDocument: {fsPath: '', isDirty: true, isUntitled: true},
      }),
    ),
    scan: async () => {
      scanned = true;
      return emptySnapshot('/unused');
    },
  });
  await controller.run('grafyxAtlas.showImpact');
  assert(scanned === false, 'untitled text is not sent to atlas');
  assert(host.errors[0]?.includes('Save the file') === true, 'the user is told to save');
});

test('a thrown atlas error is logged with its stack and shown', async () => {
  const host = fakeHost();
  const controller = createAtlasController({
    ...options(host, fakeMap(), workspace({folders: ['/proj']})),
    scan: async () => {
      throw new Error('boom');
    },
  });
  await controller.run('grafyxAtlas.showStats');
  assert(host.errors[0] === 'boom', 'the message is unchanged');
  assert(
    host.logs.some((line) => line.includes('boom')),
    'the output channel keeps the error',
  );
});

test('a bad PORT is shown and does not kill the host', async () => {
  const host = fakeHost();
  const controller = createAtlasController(
    options(host, fakeMap(), workspace({folders: ['/proj']}), settings(), 'nope'),
  );
  await controller.run('grafyxAtlas.openMap');
  assert(host.errors[0]?.includes('nope') === true, 'the rejected port is in the message');
});

test('stopping a map that is not running is quiet', async () => {
  const host = fakeHost();
  const controller = createAtlasController(options(host, fakeMap(), workspace()));
  await controller.run('grafyxAtlas.stopMap');
  assert(
    host.infos[0] === 'Grafyx Atlas is not running.',
    'stop does not pretend a server existed',
  );
  assert(host.errors.length === 0, 'stop is not an error');
});

function folder(root: string): WorkspaceContext {
  return workspace({folders: [root], dirtyPaths: []});
}

function uri(fsPath: string): {scheme: string; fsPath: string} {
  return {scheme: 'file', fsPath};
}

function emptySnapshot(root: string): AtlasSnapshot {
  return {
    nodes: [],
    edges: [],
    extractedAt: '2026-01-01T00:00:00.000Z',
    root,
    kind: 'source',
  };
}

function options(
  host: FakeHost,
  map: ReturnType<typeof fakeMap>,
  initial: WorkspaceContext,
  current = settings(),
  envPort?: string,
): AtlasControllerOptions {
  return {
    host,
    mapServer: map,
    readSettings: () => current,
    envPort,
    readWorkspace: (argument) => {
      const targetPath = filePathFromCommandArgument(argument);
      return {
        ...initial,
        ...(targetPath !== undefined ? {targetPath} : {}),
      };
    },
  };
}
