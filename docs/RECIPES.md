# Recipes

Integration recipes for `grafyx`. None of these integrations add runtime
dependencies to `grafyx`; the host application installs the framework or
SDK it already uses.

## Writing a plugin

A plugin is a named `install` function that may return a cleanup callback.
Cleanup runs on `uninstall()` or `runtime.dispose()`, in reverse installation
order.

```ts
import {ReactiveRuntime, type ReactiveRuntimePlugin} from 'grafyx';

const slowComputationLogger = (thresholdMs: number): ReactiveRuntimePlugin => ({
  name: 'slow-computation-logger',
  install(runtime) {
    return runtime.subscribe((event) => {
      if (event.type === 'computation-completed' && event.durationMs > thresholdMs) {
        console.warn(`${event.nodeId} took ${event.durationMs.toFixed(1)} ms`);
      }
    });
  },
});

const runtime = new ReactiveRuntime();
const uninstall = runtime.use(slowComputationLogger(16));
```

Listeners run with dependency tracking suspended, so reading reactive values
inside a listener never creates a dependency. Listener errors are isolated and
counted in `runtime.state.eventListenerErrorCount`.

## React

`createExternalStore` implements the contract of `useSyncExternalStore`.
Create one store per source and reuse it across renders.

```tsx
import {useSyncExternalStore} from 'react';
import {createExternalStore, createMicrotaskScheduler} from 'grafyx/store';

const scheduler = createMicrotaskScheduler();
const totalStore = createExternalStore(runtime, total, {scheduler});

export function Total() {
  const value = useSyncExternalStore(totalStore.subscribe, totalStore.getSnapshot);
  return <output>{value}</output>;
}
```

With the microtask scheduler, components update automatically after writes.
Without it, notifications are delivered on `runtime.flush()`. If the source
throws, `getSnapshot()` rethrows during render so an error boundary can handle
it.

## Vue

```ts
import {customRef, onScopeDispose, type Ref} from 'vue';
import type {ReactiveExternalStore} from 'grafyx/store';

export function useReactive<T>(store: ReactiveExternalStore<T>): Readonly<Ref<T>> {
  return customRef<T>((track, trigger) => {
    onScopeDispose(store.subscribe(trigger));

    return {
      get() {
        track();
        return store.getSnapshot();
      },
      set() {
        throw new Error('grafyx stores are read-only; write to the source value.');
      },
    };
  });
}
```

## Svelte

`toSvelteStore` returns an object that follows the Svelte store contract, so
`$store` syntax works directly.

```svelte
<script lang="ts">
  import {createExternalStore, createMicrotaskScheduler, toSvelteStore} from 'grafyx/store';

  const total$ = toSvelteStore(
    createExternalStore(runtime, total, {scheduler: createMicrotaskScheduler()}),
  );
</script>

<output>{$total$}</output>
```

## Solid

```ts
import {from} from 'solid-js';

const totalSignal = from<number>((set) => {
  set(() => totalStore.getSnapshot());
  return totalStore.subscribe(() => set(() => totalStore.getSnapshot()));
});
```

## OpenTelemetry

The adapter accepts any tracer with the OpenTelemetry `startSpan` shape, so
`@opentelemetry/api` stays in your dependencies, not grafyx's.

```ts
import {context, trace} from '@opentelemetry/api';
import {createOpenTelemetryPlugin} from 'grafyx/opentelemetry';

runtime.use(
  createOpenTelemetryPlugin({
    tracer: trace.getTracer('my-app'),
    parentContext: (span) => trace.setSpan(context.active(), span),
  }),
);
```

It records these spans:

| Span              | Covers                         | Key attributes                                              |
| ----------------- | ------------------------------ | ----------------------------------------------------------- |
| `grafyx.batch`    | an outermost `runtime.batch()` | `grafyx.batch.changed_nodes`, `grafyx.batch.deferred_tasks` |
| `grafyx.computed` | one computed evaluation        | `grafyx.node.id`, `grafyx.value_changed`                    |
| `grafyx.effect`   | one effect run                 | `grafyx.node.id`                                            |

Computations nest under the batch or computation that triggered them. Source
changes and invalidations become span events carrying the causal path, for
example `grafyx.path = "price > subtotal > total"`. Failed computations
set the span status to `ERROR` with the error message. Pass
`recordInvalidations: false` to keep spans small on very wide graphs.

## MCP server

`grafyx/inspector` provides read-only tools and converts them to the MCP
tool and result shapes. Wire them into the official SDK's low-level server:

```ts
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {callMcpTool, createInspectorTools, toMcpTools} from 'grafyx/inspector';

const tools = createInspectorTools(runtime, {maxResults: 200});
const server = new Server({name: 'my-app-graph', version: '1.0.0'}, {capabilities: {tools: {}}});

server.setRequestHandler(ListToolsRequestSchema, () => ({tools: toMcpTools(tools)}));
server.setRequestHandler(CallToolRequestSchema, (request) => callMcpTool(tools, request.params));

await server.connect(new StdioServerTransport());
```

The runtime lives in your process, so the MCP server must too. Stdio suits
scripts and CLIs; long-running services should use the SDK's Streamable HTTP
transport. Create the runtime with a `traceBufferSize` so
`grafyx_trace` has history to return.

| Tool                  | Purpose                                               |
| --------------------- | ----------------------------------------------------- |
| `grafyx_describe`     | runtime state, graph metrics, plugins, schema version |
| `grafyx_list_nodes`   | nodes filtered by kind, dirty state, or ID prefix     |
| `grafyx_explain`      | one node's state and its latest invalidation path     |
| `grafyx_dependencies` | transitive upstream or downstream nodes with depth    |
| `grafyx_trace`        | retained events after a cursor, by type or node       |
| `grafyx_snapshot`     | bounded snapshot of nodes and edges                   |

Every tool validates its input, is annotated `readOnlyHint: true`, and cannot
mutate the runtime. Invalid input becomes an MCP tool error the model can read.

## Devtools bridge

`createDevtoolsBridge` streams versioned messages over any transport and
answers inspection requests.

```ts
import {createDevtoolsBridge} from 'grafyx/devtools';

const bridge = createDevtoolsBridge({
  runtimeId: 'checkout',
  send: (message) => window.postMessage(message, window.location.origin),
});

runtime.use(bridge);
window.addEventListener('message', (event) => {
  if (event.origin === window.location.origin) bridge.receive(event.data);
});
```

On install the bridge sends `hello` with a full snapshot. Events emitted in one
task are coalesced into a single `events` message; when the queue exceeds
`maxQueuedEvents`, the oldest events are dropped and counted. Clients send:

```json
{
  "protocol": "grafyx-devtools",
  "version": 1,
  "runtimeId": "checkout",
  "type": "request",
  "requestId": "1",
  "tool": "grafyx_explain",
  "input": {"nodeId": "total"}
}
```

and receive a `response` with the same `requestId`. Messages for another
protocol or runtime are ignored, so several runtimes can share one channel.
