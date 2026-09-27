import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {assert, ensure} from '../../../test/assert.js';
import {extractProject} from '../src/extract-project.js';
import {extractSourceFocus} from '../src/extract-source.js';
import {IMPORTS} from '../src/model.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

test('a single project is drawn as its src structure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-source-'));

  try {
    await mkdir(join(root, 'src/agents'), {recursive: true});
    await mkdir(join(root, 'src/communication'), {recursive: true});
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({name: 'multi-agent', version: '1.0.0'}),
    );
    await writeFile(join(root, 'src/agents/Agent.ts'), 'export class Agent {}\n');
    await writeFile(
      join(root, 'src/agents/CodingAgent.ts'),
      "import {Agent} from './Agent.js';\nimport {handoff} from '../communication/handoffs.js';\nexport class CodingAgent extends Agent {}\n",
    );
    await writeFile(join(root, 'src/communication/handoffs.ts'), 'export function handoff() {}\n');
    await writeFile(
      join(root, 'src/index.ts'),
      "import {CodingAgent} from './agents/CodingAgent.js';\nexport {CodingAgent};\n",
    );
    await writeFile(join(root, 'src/config.ts'), 'export const name = "multi-agent";\n');

    const snapshot = await extractProject(root);
    const ids = new Set(snapshot.nodes.map((node) => node.id));
    const agents = snapshot.nodes.find((node) => node.id === 'agents');

    assert(snapshot.kind === 'source', 'a single project uses the source map');
    assert(ids.has('agents') && ids.has('communication'), 'folders are structure nodes');
    assert(ids.has('index.ts') && ids.has('config.ts'), 'loose source files are nodes');
    assert(!ids.has('multi-agent'), 'the package is not the picture');
    const agentFiles = new Set(agents?.files ?? []);
    assert(
      agentFiles.has('Agent.ts') && agentFiles.has('CodingAgent.ts'),
      'the folder tooltip lists its files',
    );
    assert(agents?.path === 'src/agents', 'the node records the source path');

    const edge = (from: string, to: string) =>
      snapshot.edges.some(
        (item) => item.relation === IMPORTS && item.from === from && item.to === to,
      );

    assert(edge('communication', 'agents'), 'agents stands on communication');
    assert(edge('agents', 'index.ts'), 'index stands on agents');
    assert(!edge('config.ts', 'index.ts'), 'config is not imported');
    assert(
      !snapshot.edges.some((item) => item.from === 'agents' && item.to === 'agents'),
      'imports inside a folder are not edges',
    );

    const deeper = await extractSourceFocus(root, 'src/agents');
    ensure(deeper !== null, 'a folder can open into its files');
    const deeperIds = new Set(deeper.nodes.map((node) => node.id));
    const deeperEdge = (from: string, to: string) =>
      deeper?.edges.some(
        (item) => item.relation === IMPORTS && item.from === from && item.to === to,
      ) === true;

    assert(deeperIds.has('CodingAgent.ts') && deeperIds.has('Agent.ts'), 'files become nodes');
    assert(deeperIds.has('handoffs.ts'), 'an imported file outside the folder stays visible');
    assert(deeperEdge('Agent.ts', 'CodingAgent.ts'), 'an internal import is a link');
    assert(deeperEdge('handoffs.ts', 'CodingAgent.ts'), 'an outside import is a link');
    assert(
      deeper.nodes.find((node) => node.id === 'handoffs.ts')?.description === 'Outside this part.',
      'outside files are marked',
    );
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('a nested folder opens as parts, not path-shaped files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-nested-'));

  try {
    await mkdir(join(root, 'app/auth'), {recursive: true});
    await writeFile(
      join(root, 'app/page.tsx'),
      "import {AuthPage} from './auth/page';\nexport default function Page() { return AuthPage; }\n",
    );
    await writeFile(
      join(root, 'app/auth/page.tsx'),
      'export function AuthPage() { return null; }\n',
    );
    await writeFile(
      join(root, 'app/layout.tsx'),
      'export default function Layout() { return null; }\n',
    );

    const deeper = await extractSourceFocus(root, 'app');
    ensure(deeper !== null, 'the app folder opens');
    const ids = new Set(deeper.nodes.map((node) => node.id));
    const auth = deeper.nodes.find((node) => node.id === 'auth');

    assert(
      ids.has('page.tsx') && ids.has('layout.tsx') && ids.has('auth'),
      'the next level is the picture',
    );
    assert(!ids.has('app/auth/page.tsx'), 'a nested file is not named with its path');
    assert(auth?.path === 'app/auth', 'the child folder can open again');
    assert(auth?.files?.includes('page.tsx') === true, 'the child folder lists its page');
    assert(
      deeper.edges.some(
        (edge) => edge.relation === IMPORTS && edge.from === 'auth' && edge.to === 'page.tsx',
      ),
      'the page stands on the auth folder',
    );

    const authLevel = await extractSourceFocus(root, 'app/auth');
    ensure(authLevel !== null, 'the auth folder opens');
    assert(
      authLevel.nodes.some((node) => node.id === 'page.tsx'),
      'the page is a file once the folder is open',
    );
    assert(
      !authLevel.nodes.some((node) => node.id === 'app/auth/page.tsx'),
      'the open folder does not keep the path as a name',
    );
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('a tsconfig path alias links search/page.tsx to services/api.ts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-alias-'));

  try {
    await mkdir(join(root, 'src/app/search'), {recursive: true});
    await mkdir(join(root, 'src/services'), {recursive: true});
    await writeFile(
      join(root, 'tsconfig.json'),
      `{
        // Next.js alias
        "compilerOptions": {
          "paths": { "@/*": ["./src/*"] },
        }
      }`,
    );
    await writeFile(
      join(root, 'src/app/search/page.tsx'),
      "import {queryRag} from '@/services/api';\nimport {useState} from 'react';\nexport default function Page() { return queryRag; }\n",
    );
    await writeFile(
      join(root, 'src/services/api.ts'),
      'export function queryRag() { return null; }\n',
    );

    const snapshot = await extractProject(root);
    assert(
      snapshot.edges.some(
        (edge) => edge.relation === IMPORTS && edge.from === 'services' && edge.to === 'app',
      ),
      'search stands on services through the @ alias',
    );
    assert(
      !snapshot.edges.some((edge) => edge.from === 'react' || edge.to === 'react'),
      'a package import is not a source edge',
    );

    const search = await extractSourceFocus(root, 'src/app/search');
    ensure(search !== null, 'the search folder opens');
    assert(
      search.edges.some(
        (edge) => edge.relation === IMPORTS && edge.from === 'api.ts' && edge.to === 'page.tsx',
      ),
      'page.tsx stands on api.ts',
    );
    assert(
      search.nodes.find((node) => node.id === 'api.ts')?.version === 'link',
      'api.ts is outside the search folder',
    );
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('a workspace of several packages stays a package map', async () => {
  const snapshot = await extractProject(repoRoot);
  const ids = new Set(snapshot.nodes.map((node) => node.id));

  assert(snapshot.kind === 'workspace', 'this repository stays a workspace map');
  assert(ids.has('grafyx-graph'), 'packages remain the nodes');
  assert(!ids.has('main.tsx'), 'source files are not nodes in a workspace');
});
