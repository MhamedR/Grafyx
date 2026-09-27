/**
 * Starts the atlas CLI the way a user does: tsx on src/server.ts.
 * --help must work without a grafyx build. The HTTP map needs that build,
 * so the listen test skips when dist is missing (coverage runs before build).
 */

import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {assert, ensure} from '../../../test/assert.js';

const atlasDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(atlasDir, '../..');
const grafyxEntry = join(repoRoot, 'packages/grafyx/dist/grafyx/index.js');
const tsx = join(repoRoot, 'node_modules/tsx/dist/cli.mjs');

function runCli(args: string[]): Promise<{code: number | null; stdout: string; stderr: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsx, 'src/server.ts', ...args], {
      cwd: atlasDir,
      env: {...process.env, CI: 'true'},
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({code, stdout, stderr}));
  });
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not bind a test port.'));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function sourceFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'atlas-cli-'));
  await mkdir(join(root, 'src/models'), {recursive: true});
  await mkdir(join(root, 'src/services'), {recursive: true});
  await writeFile(join(root, 'package.json'), JSON.stringify({name: 'cli-app', version: '1.0.0'}));
  await writeFile(join(root, 'src/models/user.ts'), 'export interface User { id: string }\n');
  await writeFile(
    join(root, 'src/services/auth.ts'),
    "import type {User} from '../models/user.js';\nexport const current = (): User => ({id: '1'});\n",
  );
  return root;
}

test('grafyx-atlas --help prints the options and exits', async () => {
  const help = await runCli(['--help']);
  assert(help.code === 0, '--help exits 0');
  assert(help.stdout.includes('Usage: grafyx-atlas'), 'the usage line names the bin');
  assert(help.stdout.includes('--root <path>'), 'help lists --root');
  assert(help.stdout.includes('--port <number>'), 'help lists --port');
  assert(help.stdout.includes('--no-open'), 'help lists --no-open');

  const short = await runCli(['-h']);
  assert(short.code === 0, '-h exits 0');
  assert(short.stdout.includes('Usage: grafyx-atlas'), '-h prints the same usage');
});

test(
  'the CLI serves the map, snapshot, and a deeper folder',
  {skip: !existsSync(grafyxEntry)},
  async () => {
    const root = await sourceFixture();
    const port = await freePort();
    const child = spawn(
      process.execPath,
      [tsx, 'src/server.ts', '--root', root, '--port', String(port), '--no-open'],
      {cwd: atlasDir, env: {...process.env, CI: 'true'}},
    );

    let ready = '';
    const started = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Atlas did not start.')), 20_000);
      const onData = (chunk: Buffer): void => {
        ready += chunk.toString();
        if (ready.includes(`http://127.0.0.1:${port}`)) {
          clearTimeout(timer);
          child.stdout.off('data', onData);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', (code) => {
        if (!ready.includes('http://127.0.0.1')) {
          clearTimeout(timer);
          reject(new Error(`Atlas exited ${code} before listen.\n${ready}`));
        }
      });
    });

    try {
      await started;

      const page = await fetch(`http://127.0.0.1:${port}/`);
      const html = await page.text();
      assert(page.ok, 'the map page loads');
      assert(html.includes('<title>grafyx/atlas</title>'), 'the page is titled grafyx/atlas');
      assert(html.includes('atlas-boot'), 'the page carries the boot snapshot');

      const snapshotResponse = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
      const snapshot = (await snapshotResponse.json()) as {
        kind?: string;
        nodes: Array<{id: string; path: string}>;
      };
      assert(snapshotResponse.ok, 'snapshot is served');
      assert(snapshot.kind === 'source', 'a single app is a source map');
      const ids = snapshot.nodes.map((node) => node.id).sort();
      assert(ids.join(',') === 'models,services', 'models and services are the parts');
      const services = snapshot.nodes.find((node) => node.id === 'services');
      ensure(services !== undefined, 'services is on the map');

      const focus = await fetch(
        `http://127.0.0.1:${port}/api/focus?path=${encodeURIComponent(services.path)}`,
      );
      const deeper = (await focus.json()) as {nodes: Array<{id: string}>};
      assert(focus.ok, 'Go deeper returns the folder');
      assert(
        deeper.nodes.some((node) => node.id === 'auth.ts'),
        'the files inside services are on the map',
      );

      const missing = await fetch(`http://127.0.0.1:${port}/api/focus?path=no-such-part`);
      assert(missing.status === 404, 'an unknown folder is 404');

      const css = await fetch(`http://127.0.0.1:${port}/atlas.css`);
      assert(css.ok && (await css.text()).includes('.'), 'the stylesheet is served');

      const script = await fetch(`http://127.0.0.1:${port}/app.js`);
      assert(script.ok && (await script.text()).includes('grafyx'), 'the UI bundle is served');

      const unknown = await fetch(`http://127.0.0.1:${port}/nope`);
      assert(unknown.status === 404, 'unknown paths are 404');
    } finally {
      child.kill('SIGTERM');
      await rm(root, {recursive: true, force: true});
    }
  },
);

test(
  'a missing project root fails the snapshot with the path',
  {skip: !existsSync(grafyxEntry)},
  async () => {
    const port = await freePort();
    const missing = join(tmpdir(), `atlas-missing-${process.pid}`);
    const child = spawn(
      process.execPath,
      [tsx, 'src/server.ts', '--root', missing, '--port', String(port), '--no-open'],
      {cwd: atlasDir, env: {...process.env, CI: 'true'}},
    );

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Atlas did not start.')), 20_000);
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes(`http://127.0.0.1:${port}`)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', reject);
    });

    try {
      const page = await fetch(`http://127.0.0.1:${port}/`);
      const html = await page.text();
      assert(page.ok, 'the page still loads when the root is empty');
      assert(
        html.includes('Cannot read') || html.includes(missing),
        'the boot payload keeps the error',
      );
    } finally {
      child.kill('SIGTERM');
    }
  },
);
