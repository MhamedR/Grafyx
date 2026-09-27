import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {
  ReactiveComputed,
  ReactiveEffect,
  ReactiveRuntime,
  ReactiveValue,
} from '../../reactive/index.js';
import {
  InspectorInputError,
  callInspectorTool,
  callMcpTool,
  createInspectorTools,
  toMcpTools,
} from '../inspector.js';
import {ensure} from '../../../test/assert.js';

function createFixture(): ReactiveRuntime {
  const runtime = new ReactiveRuntime({traceBufferSize: 100});
  const price = new ReactiveValue(runtime, 'price', 10);
  const quantity = new ReactiveValue(runtime, 'quantity', 2);
  const subtotal = new ReactiveComputed(runtime, 'subtotal', () => price.value * quantity.value);
  const total = new ReactiveComputed(runtime, 'total', () => subtotal.value * 1.2);
  const render = new ReactiveEffect(runtime, 'render', () => {
    void total.value;
  });

  render.run();
  price.value = 12;
  return runtime;
}

function expectInputError(run: () => unknown, message: string): void {
  let thrown: unknown;

  try {
    run();
  } catch (error) {
    thrown = error;
  }

  ensure(thrown instanceof InspectorInputError, message);
}

function testInspectorTools(): void {
  const runtime = createFixture();
  const tools = createInspectorTools(runtime, {maxResults: 50});

  ensure(
    tools.map((tool) => tool.name).join(',') ===
      'grafyx_describe,grafyx_list_nodes,grafyx_explain,grafyx_dependencies,grafyx_trace,grafyx_snapshot',
    'the inspector should expose a stable tool set',
  );

  const describe = callInspectorTool(tools, 'grafyx_describe');
  ensure(describe['schemaVersion'] === 1, 'describe should include the event schema version');

  const dirty = callInspectorTool(tools, 'grafyx_list_nodes', {
    dirty: true,
    kind: 'computed',
  });
  ensure(
    JSON.stringify((dirty['nodes'] as {id: string}[]).map((node) => node.id)) ===
      '["subtotal","total"]',
    'list_nodes should filter by kind and dirty state',
  );

  const limited = callInspectorTool(tools, 'grafyx_list_nodes', {limit: 1});
  ensure(
    limited['truncated'] === true && limited['total'] === 5,
    'list_nodes should report truncation',
  );

  const explanation = callInspectorTool(tools, 'grafyx_explain', {nodeId: 'render'});
  ensure(
    JSON.stringify((explanation['invalidation'] as {path: string[]}).path) ===
      '["price","subtotal","total","render"]',
    'explain should return the causal invalidation path',
  );

  const upstream = callInspectorTool(tools, 'grafyx_dependencies', {
    nodeId: 'render',
    direction: 'upstream',
  });
  ensure(
    JSON.stringify(upstream['nodes']) ===
      JSON.stringify([
        {id: 'total', depth: 1},
        {id: 'subtotal', depth: 2},
        {id: 'price', depth: 3},
        {id: 'quantity', depth: 3},
      ]),
    'dependencies should walk producers breadth first with depth',
  );

  const shallow = callInspectorTool(tools, 'grafyx_dependencies', {
    nodeId: 'price',
    direction: 'downstream',
    maxDepth: 1,
  });
  ensure((shallow['nodes'] as unknown[]).length === 1, 'maxDepth should bound the walk');

  const truncated = callInspectorTool(tools, 'grafyx_dependencies', {
    nodeId: 'render',
    direction: 'upstream',
    limit: 2,
  });
  ensure(truncated['truncated'] === true, 'dependency walks should report truncation');

  const trace = callInspectorTool(tools, 'grafyx_trace', {
    types: ['node-changed'],
    nodeId: 'price',
  });
  ensure((trace['events'] as unknown[]).length === 1, 'trace should filter by type and node');

  const snapshot = callInspectorTool(tools, 'grafyx_snapshot', {limit: 2});
  ensure(
    snapshot['totalNodes'] === 5 && (snapshot['nodes'] as unknown[]).length === 2,
    'snapshot should honor the limit',
  );
  ensure(
    (snapshot['edges'] as {producerId: string; consumerId: string}[]).every(
      (edge) => edge.producerId === 'price' || edge.producerId === 'quantity',
    ),
    'snapshot edges should only reference included nodes',
  );

  expectInputError(() => callInspectorTool(tools, 'missing'), 'unknown tools should be rejected');
  expectInputError(
    () => callInspectorTool(tools, 'grafyx_list_nodes', {extra: true}),
    'unknown properties should be rejected',
  );
  expectInputError(
    () => callInspectorTool(tools, 'grafyx_list_nodes', {limit: 51}),
    'limits above maxResults should be rejected',
  );
  expectInputError(
    () => callInspectorTool(tools, 'grafyx_explain', {}),
    'required properties should be enforced',
  );
  expectInputError(
    () => callInspectorTool(tools, 'grafyx_trace', {types: ['bogus']}),
    'enum arrays should be validated',
  );
  expectInputError(
    () => callInspectorTool(tools, 'grafyx_describe', []),
    'non-object input should be rejected',
  );

  const detached = tools[0]?.call;
  ensure(detached?.()['schemaVersion'] === 1, 'tool calls should work when detached');
}

function testMcpHelpers(): void {
  const tools = createInspectorTools(createFixture());
  const definitions = toMcpTools(tools);

  ensure(
    definitions.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint),
    'MCP tools should be annotated as read-only',
  );

  const error = callMcpTool(tools, {name: 'grafyx_explain', arguments: {nodeId: 'nope'}});
  ensure(error.isError === true, 'tool failures should become MCP error results');
  ensure(error.content[0]?.text.includes('nope') === true, 'MCP errors should explain the failure');
}

async function testMcpServerRoundTrip(): Promise<void> {
  const tools = createInspectorTools(createFixture());
  const server = new Server({name: 'grafyx-test', version: '1.0.0'}, {capabilities: {tools: {}}});

  server.setRequestHandler(ListToolsRequestSchema, () => ({tools: toMcpTools(tools)}));
  server.setRequestHandler(CallToolRequestSchema, (request) => callMcpTool(tools, request.params));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({name: 'grafyx-test-client', version: '1.0.0'});

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const listed = await client.listTools();
    ensure(listed.tools.length === tools.length, 'the MCP client should list every inspector tool');
    ensure(
      listed.tools.every((tool) => tool.annotations?.readOnlyHint === true),
      'annotations should survive MCP schema validation',
    );

    const result = await client.callTool({
      name: 'grafyx_explain',
      arguments: {nodeId: 'total'},
    });
    const structured = result.structuredContent as {invalidation?: {sourceNodeId?: string}};
    ensure(
      structured.invalidation?.sourceNodeId === 'price',
      'MCP calls should return explanations',
    );

    const failed = await client.callTool({name: 'grafyx_explain', arguments: {}});
    ensure(failed.isError === true, 'invalid MCP calls should return tool errors');
  } finally {
    await client.close();
    await server.close();
  }
}

testInspectorTools();
testMcpHelpers();
await testMcpServerRoundTrip();
