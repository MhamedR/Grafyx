import {mkdtemp, mkdir, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {test} from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {assert, ensure} from '../../../test/assert.js';
import {atlasEdgeId, type AtlasSnapshot} from '../src/model.js';
import {
  AtlasMcpInputError,
  callAtlasTool,
  callMcpTool,
  connectAtlasMcp,
  createAtlasMcpTools,
  startAtlasMcpServer,
  toMcpTools,
} from '../src/mcp.js';

const TOOL_NAMES =
  'atlas_map,atlas_impact,atlas_upstream,atlas_cycles,atlas_order,atlas_stats,atlas_focus,atlas_path,atlas_part';

async function sourceProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'atlas-mcp-'));
  await mkdir(join(root, 'src/models'), {recursive: true});
  await mkdir(join(root, 'src/services'), {recursive: true});
  await writeFile(join(root, 'package.json'), JSON.stringify({name: 'app', version: '1.0.0'}));
  await writeFile(join(root, 'src/models/user.ts'), 'export interface User { id: string }\n');
  await writeFile(
    join(root, 'src/services/auth.ts'),
    "import type {User} from '../models/user.js';\nexport const current = (): User => ({id: '1'});\n",
  );
  return root;
}

async function cycleProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'atlas-mcp-cycle-'));
  await mkdir(join(root, 'src/auth'), {recursive: true});
  await mkdir(join(root, 'src/users'), {recursive: true});
  await writeFile(join(root, 'package.json'), JSON.stringify({name: 'loop', version: '1.0.0'}));
  await writeFile(
    join(root, 'src/auth/session.ts'),
    "import {user} from '../users/user.js';\nexport const session = user;\n",
  );
  await writeFile(
    join(root, 'src/users/user.ts'),
    "import {session} from '../auth/session.js';\nexport const user = session;\n",
  );
  return root;
}

function fixtureSnapshot(): AtlasSnapshot {
  return {
    root: '/app',
    extractedAt: '2026-10-01T00:00:00.000Z',
    kind: 'source',
    scan: {durationMs: 4, fileCount: 2, byteCount: 80, lineCount: 6},
    nodes: [
      {
        id: 'models',
        version: '',
        private: false,
        path: 'src/models',
        description: '',
        files: ['user.ts'],
        measures: [{path: 'user.ts', bytes: 30, lines: 2}],
      },
      {
        id: 'services',
        version: '',
        private: false,
        path: 'src/services',
        description: '',
        files: ['auth.ts'],
        measures: [{path: 'auth.ts', bytes: 50, lines: 4}],
      },
    ],
    edges: [
      {
        id: atlasEdgeId('imports', 'models', 'services'),
        from: 'models',
        to: 'services',
        relation: 'imports',
      },
    ],
  };
}

async function expectInputError(run: () => Promise<unknown>, message: string): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  ensure(thrown instanceof AtlasMcpInputError, message);
}

test('atlas MCP tools scan a project and answer the lenses', async () => {
  const root = await sourceProject();
  const tools = createAtlasMcpTools({root});

  try {
    assert(tools.map((tool) => tool.name).join(',') === TOOL_NAMES, 'the tool set is stable');

    const map = await callAtlasTool(tools, 'atlas_map');
    const nodes = map['nodes'] as Array<{id: string}>;
    const ids = nodes
      .map((node) => node.id)
      .sort()
      .join(',');
    assert(map['kind'] === 'source', 'a single app is a source map');
    assert(ids === 'models,services', 'models and services are the parts');
    assert(typeof map['question'] === 'string', 'the map carries its lens sentence');

    const impact = await callAtlasTool(tools, 'atlas_impact', {id: 'serv'});
    assert(impact['id'] === 'services', 'a unique prefix selects services');
    assert((impact['reached'] as string[]).length === 0, 'services reaches nothing else');

    const fromModels = await callAtlasTool(tools, 'atlas_impact', {id: 'models'});
    assert((fromModels['reached'] as string[]).join(',') === 'services', 'models reaches services');

    const stoodOn = await callAtlasTool(tools, 'atlas_upstream', {id: 'services'});
    assert((stoodOn['stoodOn'] as string[]).join(',') === 'models', 'services stands on models');

    const loops = await callAtlasTool(tools, 'atlas_cycles');
    assert((loops['cycles'] as unknown[]).length === 0, 'this app has a build order');
    assert(typeof loops['question'] === 'string', 'cycles explains the empty result');

    const schedule = await callAtlasTool(tools, 'atlas_order');
    assert(schedule['kind'] === 'order', 'a dag returns an order');
    assert((schedule['ids'] as string[])[0] === 'models', 'models comes first');

    const stats = await callAtlasTool(tools, 'atlas_stats');
    const totals = stats['totals'] as {files: number};
    assert(totals.files === 2, 'stats count the source files');

    const deeper = await callAtlasTool(tools, 'atlas_focus', {path: 'services'});
    const deeperIds = (deeper['nodes'] as Array<{id: string}>).map((node) => node.id);
    assert(deeperIds.includes('auth.ts'), 'go deeper opens the files inside services');

    const byPath = await callAtlasTool(tools, 'atlas_focus', {path: 'src/models'});
    assert(
      (byPath['nodes'] as Array<{id: string}>).some((node) => node.id === 'user.ts'),
      'a source path also opens a folder',
    );

    const route = await callAtlasTool(tools, 'atlas_path', {from: 'models', to: 'services'});
    assert((route['path'] as string[]).join(',') === 'models,services', 'path follows the edge');

    const missingRoute = await callAtlasTool(tools, 'atlas_path', {from: 'services', to: 'models'});
    assert(missingRoute['path'] === null, 'there is no path against the edges');

    const part = await callAtlasTool(tools, 'atlas_part', {id: 'services'});
    assert(part['id'] === 'services', 'part describes services');
    assert(part['inDegree'] === 1, 'services has one incoming edge');
    assert(
      (part['standsOn'] as Array<{id: string}>)[0]?.id === 'models',
      'the neighbour is models',
    );
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('atlas MCP reports cycles instead of a schedule', async () => {
  const root = await cycleProject();
  const tools = createAtlasMcpTools({root});

  try {
    const loops = await callAtlasTool(tools, 'atlas_cycles');
    const found = loops['cycles'] as string[][];
    assert(found.length === 1, 'the loop is reported');
    assert(found[0]?.sort().join(',') === 'auth,users', 'auth and users stand on each other');

    const schedule = await callAtlasTool(tools, 'atlas_order');
    assert(schedule['kind'] === 'cycle', 'order names the loop when there is no schedule');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('atlas MCP validates input and caches scans', async () => {
  let scans = 0;
  const snapshot = fixtureSnapshot();
  const tools = createAtlasMcpTools({
    root: '/app',
    extract: async () => {
      scans += 1;
      return snapshot;
    },
    focus: async () => null,
  });

  await callAtlasTool(tools, 'atlas_map');
  await callAtlasTool(tools, 'atlas_stats');
  assert(scans === 1, 'the snapshot is reused');
  await callAtlasTool(tools, 'atlas_map', {refresh: true});
  assert(scans === 2, 'refresh rescans');

  await expectInputError(() => callAtlasTool(tools, 'missing'), 'unknown tools are rejected');
  await expectInputError(
    () => callAtlasTool(tools, 'atlas_map', {extra: true}),
    'unknown properties are rejected',
  );
  await expectInputError(
    () => callAtlasTool(tools, 'atlas_map', []),
    'non-object input is rejected',
  );
  await expectInputError(
    () => callAtlasTool(tools, 'atlas_impact', {}),
    'required properties are enforced',
  );
  await expectInputError(
    () => callAtlasTool(tools, 'atlas_impact', {id: '   '}),
    'blank ids are rejected',
  );
  await expectInputError(
    () => callAtlasTool(tools, 'atlas_impact', {id: 1}),
    'ids must be strings',
  );
  await expectInputError(
    () => callAtlasTool(tools, 'atlas_map', {refresh: 'yes'}),
    'refresh must be a boolean',
  );
  await expectInputError(
    () => callAtlasTool(tools, 'atlas_impact', {id: 'nope'}),
    'unknown parts are rejected',
  );
  await expectInputError(
    () => callAtlasTool(tools, 'atlas_focus', {path: 'nope'}),
    'a missing folder cannot open',
  );

  const detached = tools[0]?.call;
  const mapped = await detached?.();
  assert(mapped?.['kind'] === 'source', 'tool calls work when detached');
});

test('atlas MCP helpers match the inspector MCP shapes', async () => {
  const tools = createAtlasMcpTools({
    root: '/app',
    extract: async () => fixtureSnapshot(),
  });
  const definitions = toMcpTools(tools);
  assert(
    definitions.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint),
    'MCP tools are annotated as read-only',
  );

  const error = await callMcpTool(tools, {name: 'atlas_impact', arguments: {id: 'nope'}});
  assert(error.isError === true, 'tool failures become MCP error results');
  assert(error.content[0]?.text.includes('nope') === true, 'MCP errors explain the failure');

  const ok = await callMcpTool(tools, {name: 'atlas_cycles', arguments: {}});
  assert(ok.isError !== true, 'a valid call is not an error');
  assert(ok.structuredContent?.['cycles'] !== undefined, 'structured content is returned');
});

test('scan errors become MCP tool errors', async () => {
  const tools = createAtlasMcpTools({
    root: '/missing',
    extract: async () => {
      throw new Error('Cannot read project root /missing');
    },
  });
  const result = await callMcpTool(tools, {name: 'atlas_map'});
  assert(result.isError === true, 'a missing root is a tool error');
  assert(result.content[0]?.text.includes('/missing') === true, 'the path is in the message');
});

test('an empty project names the missing part', async () => {
  const tools = createAtlasMcpTools({
    root: '/empty',
    extract: async () => ({
      root: '/empty',
      extractedAt: '2026-10-01T00:00:00.000Z',
      kind: 'workspace',
      nodes: [],
      edges: [],
    }),
  });
  await expectInputError(
    () => callAtlasTool(tools, 'atlas_part', {id: 'core'}),
    'an empty map says it has no parts',
  );
  const map = await callAtlasTool(tools, 'atlas_map');
  assert(map['kind'] === 'workspace', 'an injected workspace keeps its kind');
  assert(
    map['question'] === 'The workspace, in build order.',
    'the workspace map uses the package lens sentence',
  );
});

test('JSON-RPC stdio speaks MCP', async () => {
  const snapshot = fixtureSnapshot();
  const input = new PassThrough();
  const output = new PassThrough();
  const connection = startAtlasMcpServer({
    input,
    output,
    tools: createAtlasMcpTools({
      root: '/app',
      extract: async () => snapshot,
    }),
  });

  const messages = collectMessages(output);
  const version = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    version: string;
  };

  writeRpc(input, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: {name: 'test', version: '0'},
    },
  });
  const hello = await messages.next();
  const helloResult = resultOf(hello);
  assert(helloResult['protocolVersion'] === '2025-03-26', 'the server keeps the client protocol');
  const info = helloResult['serverInfo'] as {name: string; version: string};
  assert(info.name === 'grafyx-atlas', 'the server names itself grafyx-atlas');
  assert(info.version === version.version, 'the server version matches the package');

  writeRpc(input, {jsonrpc: '2.0', method: 'notifications/initialized'});

  writeRpc(input, {jsonrpc: '2.0', id: 2, method: 'tools/list'});
  const listed = resultOf(await messages.next());
  assert(
    (listed['tools'] as Array<{name: string}>).map((tool) => tool.name).join(',') === TOOL_NAMES,
    'tools/list returns every atlas tool',
  );

  writeRpc(input, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {name: 'atlas_order', arguments: {}},
  });
  const order = resultOf(await messages.next());
  const structured = order['structuredContent'] as {ids?: string[]};
  assert(structured.ids?.[0] === 'models', 'tools/call returns the build order');

  writeRpc(input, {jsonrpc: '2.0', id: 4, method: 'ping'});
  const pong = await messages.next();
  assert((pong as {id: number}).id === 4, 'ping is answered');

  writeRpc(input, Buffer.from('{"jsonrpc":"2.0","id":5,"method":"nope"}\n'));
  const missing = (await messages.next()) as {error?: {code: number}};
  assert(missing.error?.code === -32601, 'unknown methods are method-not-found');

  writeRpc(input, 'not-json\n');
  const parsed = (await messages.next()) as {error?: {code: number}};
  assert(parsed.error?.code === -32700, 'broken JSON is a parse error');

  writeRpc(input, '[]\n');
  const batch = (await messages.next()) as {error?: {code: number}};
  assert(batch.error?.code === -32600, 'JSON-RPC batches are rejected');

  writeRpc(input, {jsonrpc: '2.0', id: 6, method: 'tools/call', params: {}});
  const params = (await messages.next()) as {error?: {code: number}};
  assert(params.error?.code === -32602, 'tools/call without a name is invalid params');

  writeRpc(input, '\n');
  writeRpc(input, {jsonrpc: '1.0', id: 7, method: 'ping'});
  const invalid = (await messages.next()) as {error?: {code: number}};
  assert(invalid.error?.code === -32600, 'jsonrpc 1.0 is invalid');

  writeRpc(input, {
    jsonrpc: '2.0',
    id: 8,
    method: 'initialize',
    params: {
      protocolVersion: '1999-01-01',
      capabilities: {},
      clientInfo: {name: 'old', version: '0'},
    },
  });
  const fallback = resultOf(await messages.next());
  assert(fallback['protocolVersion'] === '2025-03-26', 'an unknown protocol falls back');

  connection.close();
  connection.close();
  writeRpc(input, {jsonrpc: '2.0', id: 9, method: 'ping'});
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert(messages.pending === 0, 'close stops writing');
});

test('stdio refuses work until initialize', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const connection = connectAtlasMcp(
    createAtlasMcpTools({root: '/app', extract: async () => fixtureSnapshot()}),
    {input, output},
  );
  const messages = collectMessages(output);

  writeRpc(input, {jsonrpc: '2.0', id: 1, method: 'tools/list'});
  const early = (await messages.next()) as {error?: {message: string}};
  assert(early.error?.message === 'Server not initialized', 'tools/list waits for initialize');

  writeRpc(input, {jsonrpc: '2.0', id: 2, method: 'ping'});
  const pong = await messages.next();
  assert((pong as {id: number}).id === 2, 'ping works before initialize');

  writeRpc(input, {jsonrpc: '2.0', method: 'initialized'});
  writeRpc(input, {jsonrpc: '2.0', id: 3, method: 'tools/list'});
  const listed = resultOf(await messages.next());
  assert(Array.isArray(listed['tools']), 'initialized without the prefix still starts the server');

  writeRpc(input, {jsonrpc: '2.0', method: 'notifications/cancelled'});
  writeRpc(input, {jsonrpc: '2.0', id: 4, method: ''});
  const empty = (await messages.next()) as {error?: {code: number}};
  assert(empty.error?.code === -32600, 'an empty method is invalid');

  connection.close();
});

test('the MCP SDK client can list and call atlas tools', async () => {
  const tools = createAtlasMcpTools({
    root: '/app',
    extract: async () => fixtureSnapshot(),
  });
  const server = new Server({name: 'atlas-test', version: '1.0.0'}, {capabilities: {tools: {}}});

  server.setRequestHandler(ListToolsRequestSchema, () => ({tools: toMcpTools(tools)}));
  server.setRequestHandler(CallToolRequestSchema, (request) => callMcpTool(tools, request.params));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({name: 'atlas-test-client', version: '1.0.0'});

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const listed = await client.listTools();
    assert(listed.tools.length === tools.length, 'the MCP client lists every atlas tool');
    assert(
      listed.tools.every((tool) => tool.annotations?.readOnlyHint === true),
      'annotations survive MCP schema validation',
    );

    const result = await client.callTool({name: 'atlas_impact', arguments: {id: 'models'}});
    const structured = result.structuredContent as {reached?: string[]};
    assert(structured.reached?.join(',') === 'services', 'MCP calls return impact');

    const failed = await client.callTool({name: 'atlas_impact', arguments: {}});
    assert(failed.isError === true, 'invalid MCP calls return tool errors');
  } finally {
    await client.close();
    await server.close();
  }
});

function writeRpc(input: PassThrough, message: object | string | Buffer): void {
  if (typeof message === 'string' || Buffer.isBuffer(message)) {
    input.write(message);
    return;
  }
  input.write(`${JSON.stringify(message)}\n`);
}

function resultOf(message: unknown): Record<string, unknown> {
  ensure(isRecord(message) && isRecord(message['result']), 'the MCP reply has a result');
  return message['result'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collectMessages(output: PassThrough): {
  next(): Promise<unknown>;
  readonly pending: number;
} {
  let buffer = '';
  const queue: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];

  output.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const parsed = JSON.parse(line) as unknown;
      const waiter = waiters.shift();
      if (waiter) waiter(parsed);
      else queue.push(parsed);
    }
  });

  return {
    get pending() {
      return queue.length;
    },
    next() {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}
