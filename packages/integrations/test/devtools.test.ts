import {ReactiveComputed, ReactiveRuntime, ReactiveValue} from '../../reactive/index.js';
import {
  DEVTOOLS_PROTOCOL,
  DEVTOOLS_PROTOCOL_VERSION,
  createDevtoolsBridge,
  type DevtoolsOutgoingMessage,
} from '../devtools.js';
import {ensure} from '../../../test/assert.js';

function request(
  runtimeId: string,
  requestId: string,
  tool: string,
  input?: Record<string, unknown>,
) {
  return {
    protocol: DEVTOOLS_PROTOCOL,
    version: DEVTOOLS_PROTOCOL_VERSION,
    runtimeId,
    type: 'request',
    requestId,
    tool,
    ...(input === undefined ? {} : {input}),
  };
}

async function testBridgeLifecycle(): Promise<void> {
  const messages: DevtoolsOutgoingMessage[] = [];
  const runtime = new ReactiveRuntime();
  const source = new ReactiveValue(runtime, 'source', 1);
  const doubled = new ReactiveComputed(runtime, 'doubled', () => source.value * 2);
  void doubled.value;

  const bridge = createDevtoolsBridge({
    runtimeId: 'app',
    send: (message) => messages.push(structuredClone(message)),
  });
  const uninstall = runtime.use(bridge);

  const hello = messages[0];
  ensure(hello?.type === 'hello', 'installation should announce the runtime');
  ensure(hello.snapshot.graph.nodes.length === 2, 'hello should include a graph snapshot');
  ensure(hello.tools.includes('grafyx_explain'), 'hello should list available tools');

  source.value = 2;
  source.value = 3;
  ensure(messages.length === 1, 'microtask delivery should not send events synchronously');

  await Promise.resolve();

  const events = messages[1];
  ensure(events?.type === 'events', 'events should be delivered in a batch message');
  ensure(
    events.events.filter((event) => event.type === 'node-changed').length === 2,
    'events emitted in the same task should be coalesced',
  );

  ensure(
    bridge.receive(request('app', 'r1', 'grafyx_explain', {nodeId: 'doubled'})),
    'requests for this runtime should be handled',
  );
  const response = messages.at(-1);
  ensure(
    response?.type === 'response' && response.ok && response.requestId === 'r1',
    'requests should produce successful responses',
  );

  bridge.receive(request('app', 'r2', 'grafyx_explain', {nodeId: 'missing'}));
  const failure = messages.at(-1);
  ensure(
    failure?.type === 'response' && !failure.ok && failure.error?.includes('missing') === true,
    'failed requests should produce error responses',
  );

  const countBefore = messages.length;
  ensure(!bridge.receive(request('other', 'r3', 'grafyx_describe')), 'other runtimes are ignored');
  ensure(!bridge.receive({protocol: 'unrelated'}), 'other protocols are ignored');
  ensure(!bridge.receive(null), 'non-object messages are ignored');
  ensure(messages.length === countBefore, 'ignored messages should not produce responses');

  uninstall();
  ensure(messages.at(-1)?.type === 'goodbye', 'removal should say goodbye');

  bridge.receive(request('app', 'r4', 'grafyx_describe'));
  const late = messages.at(-1);
  ensure(late?.type === 'response' && !late.ok, 'requests after removal should fail clearly');
}

function testSyncDeliveryAndBackpressure(): void {
  const messages: DevtoolsOutgoingMessage[] = [];
  const runtime = new ReactiveRuntime();
  let sendCalls = 0;
  runtime.use(
    createDevtoolsBridge({
      runtimeId: 'sync',
      delivery: 'sync',
      send: (message) => {
        sendCalls++;
        messages.push(message);
      },
    }),
  );

  new ReactiveValue(runtime, 'a', 1);
  new ReactiveValue(runtime, 'b', 2);
  ensure(sendCalls === 3, 'sync delivery should send each event immediately');

  const dropping: DevtoolsOutgoingMessage[] = [];
  const bounded = new ReactiveRuntime();
  bounded.use(
    createDevtoolsBridge({runtimeId: 'bounded', maxQueuedEvents: 2, send: (m) => dropping.push(m)}),
  );

  for (let index = 0; index < 5; index++) {
    new ReactiveValue(bounded, `v${index}`, index);
  }

  bounded.dispose();

  const delivered = dropping.find((message) => message.type === 'events');
  ensure(
    delivered?.type === 'events' && delivered.events.length === 2 && delivered.dropped >= 3,
    'the bridge should keep the newest events and report dropped ones',
  );
}

await testBridgeLifecycle();
testSyncDeliveryAndBackpressure();
