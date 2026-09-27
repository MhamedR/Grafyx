# Grafyx

Grafyx is a dependency-free, ESM-only TypeScript library for directed graphs
and deterministic push/pull reactivity. It does not ship a UI framework.
Application code keeps its own Angular, React, Vue, Svelte, or Solid runtime
and reads Grafyx through a small store adapter.

Node.js 20 or newer is required. Bundlers must be able to load ESM.

```bash
npm install grafyx
```

## What you get

- A directed graph with adjacency indexes. Adding a node, and checking,
  adding, or removing an edge, are **O(1)**.
- A reactive runtime: writable values, lazy cached computeds, and scheduled
  effects. A write dirties dependents immediately. A computed runs only when
  something reads it.
- Framework stores with no runtime dependencies. The same
  `subscribe` / `getSnapshot` contract works in Angular, React, Vue, Svelte,
  and Solid.

```ts
import {DirectedGraph, Node, ReactiveComputed, ReactiveRuntime, ReactiveValue} from 'grafyx';
```

## Directed graphs

Nodes and edges live in maps, so structural lookups do not scan the graph.

| Operation                                      | Complexity |
| ---------------------------------------------- | ---------- |
| `addNode`                                      | O(1)       |
| `hasEdge`, `getEdge`, `addEdge`, `removeEdge`  | O(1)       |
| `getOutDegree`, `getInDegree`                  | O(1)       |
| `getOutgoing`, `getIncoming`                   | O(degree)  |
| `removeNode`                                   | O(degree)  |
| BFS, DFS, ancestors, descendants, reachability | O(n + e)   |

`n` is the number of nodes and `e` is the number of edges. Duplicate edges are
ignored. Missing-node queries throw. `hasPath(graph, id, id)` is true.

```ts
import {DirectedGraph, Node, hasPath, topologicalSort} from 'grafyx/graph';

const pipeline = new DirectedGraph<{label: string}>();
pipeline.addNode(new Node('lint', {label: 'Lint'}));
pipeline.addNode(new Node('test', {label: 'Test'}));
pipeline.addNode(new Node('publish', {label: 'Publish'}));
pipeline.addEdge('lint', 'test');
pipeline.addEdge('test', 'publish');

pipeline.hasEdge('lint', 'test'); // O(1), true
pipeline.getOutDegree('test'); // O(1), 1
hasPath(pipeline, 'lint', 'publish'); // true
topologicalSort(pipeline).map((node) => node.id); // ['lint', 'test', 'publish']
```

Also exported: iterative `breadthFirstSearch` and `depthFirstSearch`,
`getReachableNodes`, `getAncestors`, `getDescendants`, `hasCycle`, and
`stronglyConnectedComponents`. `topologicalSort` throws when the graph has a
cycle.

## Reactivity

```ts
import {ReactiveComputed, ReactiveEffect, ReactiveRuntime, ReactiveValue} from 'grafyx/reactive';

const runtime = new ReactiveRuntime();
const price = new ReactiveValue(runtime, 'price', 20);
const quantity = new ReactiveValue(runtime, 'quantity', 2);
const total = new ReactiveComputed(runtime, 'total', () => price.value * quantity.value);

const seen: number[] = [];
const effect = new ReactiveEffect(runtime, 'observe', () => {
  seen.push(total.value);
});

effect.run(); // seen is [40]
price.value = 25;
runtime.flush(); // seen is [40, 50]
```

Same-value writes (`Object.is` by default) do not invalidate. Computeds rebuild
their dependencies on each run, so an unused branch is dropped. Effects do not
run until `run()` or a scheduled flush. `runtime.batch()` can nest; scheduled
effects wait until the outermost batch finishes, so several writes produce one
effect run.

```ts
runtime.batch(() => {
  price.value = 30;
  quantity.value = 3;
});
runtime.flush(); // one effect run, total is 90
```

Node IDs are unique inside one runtime. A dependency cannot cross runtimes.
`dispose()` is idempotent. Computed evaluation is synchronous and stops after
1,000 nested computeds. Grafyx does not track state across `await`; use
`AsyncReactiveScheduler` when the scheduled work itself is asynchronous.

### Why a value changed

```ts
const traced = new ReactiveRuntime({traceBufferSize: 128});

traced.subscribe((event) => {
  console.log(event.type, event.sequence);
});

traced.explain('total').invalidation?.path;
traced.getTrace({sinceSequence: 0, limit: 25});
```

`explain()` returns the latest causal path even when event retention is off.
Pass `traceBufferSize` only when you want a bounded history.

## Angular, React, Vue, Svelte, and Solid

`grafyx/store` does not import any of those frameworks. `createExternalStore`
returns `{subscribe, getSnapshot}`. Pass `createMicrotaskScheduler()` when the
view should update on its own. Without that scheduler, listeners run on
`runtime.flush()`.

Create the store once and reuse it. It observes the source only while it has
subscribers.

```ts
import {createExternalStore, createMicrotaskScheduler} from 'grafyx/store';

const totalStore = createExternalStore(runtime, total, {
  scheduler: createMicrotaskScheduler(),
});
```

### Angular

Bridge the store into a signal. Angular then updates the template when the
signal changes.

```ts
import {DestroyRef, signal} from '@angular/core';
import {createExternalStore, createMicrotaskScheduler} from 'grafyx/store';

const totalStore = createExternalStore(runtime, total, {
  scheduler: createMicrotaskScheduler(),
});

export class TotalComponent {
  readonly total = signal(totalStore.getSnapshot());

  constructor(destroyRef: DestroyRef) {
    const stop = totalStore.subscribe(() => this.total.set(totalStore.getSnapshot()));
    destroyRef.onDestroy(stop);
  }
}
```

```html
<output>{{ total() }}</output>
```

Write through the `ReactiveValue`, not through the signal. The store is
read-only.

### React

`subscribe` and `getSnapshot` match `useSyncExternalStore`.

```tsx
import {useSyncExternalStore} from 'react';

export function Total() {
  const value = useSyncExternalStore(totalStore.subscribe, totalStore.getSnapshot);
  return <output>{value}</output>;
}
```

If `getSnapshot()` throws, the error reaches the nearest error boundary.

### Vue

```ts
import {customRef, onScopeDispose, type Ref} from 'vue';
import type {ReactiveExternalStore} from 'grafyx/store';

export function useReactive<T>(store: ReactiveExternalStore<T>): Readonly<Ref<T>> {
  return customRef((track, trigger) => {
    onScopeDispose(store.subscribe(trigger));
    return {
      get() {
        track();
        return store.getSnapshot();
      },
      set() {
        throw new Error('Grafyx stores are read-only. Write to the source value.');
      },
    };
  });
}
```

### Svelte

`toSvelteStore` follows the Svelte store contract, including `$` auto-subscription.

```svelte
<script lang="ts">
  import {createExternalStore, createMicrotaskScheduler, toSvelteStore} from 'grafyx/store';

  const total$ = toSvelteStore(
    createExternalStore(runtime, total, {scheduler: createMicrotaskScheduler()}),
  );
</script>

<output>{$total$}</output>
```

### Solid

```ts
import {from} from 'solid-js';

const totalSignal = from<number>((set) => {
  set(() => totalStore.getSnapshot());
  return totalStore.subscribe(() => set(() => totalStore.getSnapshot()));
});
```

## Other entry points

| Import                 | Use                                                |
| ---------------------- | -------------------------------------------------- |
| `grafyx`               | Graph and reactive APIs together                   |
| `grafyx/graph`         | Graph only                                         |
| `grafyx/reactive`      | Reactive runtime only                              |
| `grafyx/advanced`      | Low-level reactive graph primitives for adapters   |
| `grafyx/store`         | Stores for Angular, React, Vue, Svelte, and Solid  |
| `grafyx/opentelemetry` | Batches and computations as OpenTelemetry spans    |
| `grafyx/inspector`     | Read-only inspection tools and MCP adapter helpers |
| `grafyx/devtools`      | Transport-agnostic devtools message bridge         |

Ordinary applications do not need `grafyx/advanced`.

Plugins attach with `runtime.use(plugin)`. OpenTelemetry stays out of
Grafyx's dependencies: pass a tracer that implements `startSpan`.

```ts
import {context, trace} from '@opentelemetry/api';
import {createOpenTelemetryPlugin} from 'grafyx/opentelemetry';

runtime.use(
  createOpenTelemetryPlugin({
    tracer: trace.getTracer('checkout'),
    parentContext: (span) => trace.setSpan(context.active(), span),
  }),
);
```

An outermost `runtime.batch()` becomes a `grafyx.batch` span. Each computed
evaluation and effect run becomes `grafyx.computed` or `grafyx.effect`.

## License

ISC
