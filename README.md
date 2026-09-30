# Grafyx

A framework-agnostic TypeScript library with two related subsystems:

- a directed graph with traversal and analysis algorithms
- a push/pull reactive runtime (values, computeds, effects, batching, scheduling)

The package is ESM-only, supports Node.js 20 and newer, and has no runtime dependencies.

This repository is an npm workspace. Internal packages live under `packages/`. The published package is `grafyx`.

```bash
npm install grafyx
```

```ts
import {
  DirectedGraph,
  Node,
  ReactiveComputed,
  ReactiveEffect,
  ReactiveRuntime,
  ReactiveValue,
} from 'grafyx';
```

Subpath imports are also published:

```ts
import {DirectedGraph} from 'grafyx/graph';
import {ReactiveRuntime} from 'grafyx/reactive';
```

Integration subpaths have no runtime dependencies:

| Subpath                | Purpose                                            |
| ---------------------- | -------------------------------------------------- |
| `grafyx/store`         | Stores for Angular, React, Vue, Svelte, and Solid  |
| `grafyx/opentelemetry` | batches and computations as OpenTelemetry spans    |
| `grafyx/inspector`     | read-only inspection tools and MCP adapter helpers |
| `grafyx/devtools`      | transport-agnostic devtools message bridge         |

See [docs/RECIPES.md](docs/RECIPES.md) for framework, OpenTelemetry, MCP, and
devtools setup, and [docs/API.md](docs/API.md) for the full API.

## Graph

`DirectedGraph<T>` stores `Node<T>` instances by ID and directed edges in bidirectional adjacency maps. Duplicate edges are ignored. Missing-node queries throw. Structural mutations advance `graph.version`. The default payload type is `string`; omit the payload to use the node ID.

```ts
const graph = new DirectedGraph();
graph.addNode(new Node('a'));
graph.addNode(new Node('b'));
graph.addNode(new Node('c'));
graph.addEdge('a', 'b');
graph.addEdge('b', 'c');

graph.hasEdge('a', 'b'); // true
graph.getEdge('a', 'b')?.id; // 0
graph.getOutgoing('a').map((node) => node.id); // ['b']

const users = new DirectedGraph<{name: string}>();
users.addNode(new Node('u1', {name: 'Ada'}));
users.getNode('u1')?.data.name; // 'Ada'
```

Algorithms operate on the public graph API:

| Function                                  | Behavior                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `breadthFirstSearch` / `depthFirstSearch` | Traversal from a start node                                                        |
| `hasPath` / `getReachableNodes`           | Directed reachability (`hasPath(a, a)` is true; reachable nodes exclude the start) |
| `getAncestors` / `getDescendants`         | Upstream / downstream nodes                                                        |
| `hasCycle`                                | Directed cycle detection                                                           |
| `topologicalSort`                         | Kahn sort; throws if the graph contains a cycle                                    |
| `stronglyConnectedComponents`             | Kosaraju components                                                                |

`GraphEdge` is exported for compatibility. `getEdge(from, to)` returns the shared edge object; other query methods return `Node` instances. Edge IDs are assigned per graph, starting at `0`.

### Graph complexity

| Operation                                        | Complexity |
| ------------------------------------------------ | ---------- |
| `addNode`                                        | O(1)       |
| `hasEdge` / `getEdge` / `addEdge` / `removeEdge` | O(1)       |
| `getOutDegree` / `getInDegree`                   | O(1)       |
| `getOutgoing` / `getIncoming`                    | O(degree)  |
| `removeNode`                                     | O(degree)  |
| BFS / descendants / ancestors                    | O(n + e)   |

## Reactivity

A `ReactiveRuntime` owns epoch, dependency tracking, scheduling, batching, and disposal.

```ts
const runtime = new ReactiveRuntime();
const count = new ReactiveValue(runtime, 'count', 1);
const doubled = new ReactiveComputed(runtime, 'doubled', () => count.value * 2);

const seen: number[] = [];
const effect = new ReactiveEffect(runtime, 'log', () => {
  seen.push(doubled.value);
});

effect.run(); // seen === [2]
count.value = 5;
runtime.flush(); // seen === [2, 10]
```

### Evaluation model

- **Values** are writable sources. Same-value writes (`Object.is` by default) do not invalidate.
- **Computeds** are lazy and cached. They rebuild dependencies on each run, so unused branches are dropped.
- **Effects** do not run until `run()` or a scheduled flush. Invalidation schedules the effect; `runtime.flush()` executes it.
- **Push then pull:** a write dirties descendants immediately; computeds recompute only when read.
- Reactive node IDs are unique within a runtime. Dependencies cannot cross runtime boundaries.
- Computed evaluation is limited to 1,000 nested computeds and fails with a stable error beyond that depth.

### Lifecycle

`dispose()` is idempotent.

- Disposing a value or computed invalidates consumers, then disconnects the node.
- Reading or writing a disposed value/computed throws. The failed read does not register a new dependency.
- `runtime.dispose()` disposes registered nodes and rejects later registration, scheduling, batching, and deferred work.

### Batching and scheduling

`runtime.batch()` may nest. Effect scheduling is deferred until the outermost batch completes, so several writes produce one effect run.

`ReactiveScheduler.flush()` runs the current queue as one batch. Tasks scheduled during flush wait for the next flush. If a task throws, later tasks in the same batch still run; the first error is rethrown afterward. `flushOne()` fails immediately and leaves remaining work queued.

`ManualEffectScheduler` is a deterministic alternative with the same continue-then-rethrow flush contract.

`ReactiveScheduler` and `ManualEffectScheduler` reject promise-returning tasks
instead of silently finishing a flush before async work settles.
`AsyncReactiveScheduler.flush()` explicitly awaits tasks in insertion order,
continues after failures, and rethrows the first failure after the captured
batch settles.

### Causality and diagnostics

Runtime tracing is opt-in and bounded:

```ts
const runtime = new ReactiveRuntime({traceBufferSize: 256});
const unsubscribe = runtime.subscribe((event) => {
  console.log(event.type, event.sequence);
});

// After a source write:
runtime.explain('doubled').invalidation?.path; // ['count', 'doubled']
runtime.getTrace({sinceSequence: 10, limit: 50});

unsubscribe();
runtime.clearTrace();
```

Events cover node registration and disposal, source changes, downstream
invalidations, and batch boundaries. Listener failures cannot interrupt
reactive execution and are counted by `runtime.state.eventListenerErrorCount`.
When there is no trace buffer and no subscriber, event objects and timestamps
are not created.

Graph snapshots include node kinds. `diffReactiveGraphSnapshots()` reports
added, removed, and changed nodes and edges; changed edges capture version or
staleness transitions.

Computed evaluations and effect runs emit `computation-started` and
`computation-completed` events with duration, status, and whether the value
changed. Event shapes are versioned by `REACTIVE_EVENT_SCHEMA_VERSION`.

### Plugins

`runtime.use(plugin)` installs an extension and returns an idempotent uninstall
callback. Plugin cleanup runs in reverse order when the runtime is disposed.
The OpenTelemetry exporter and devtools bridge are plugins.

### Errors

| Failure                       | Contract                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| Computed/effect throws        | Error propagates; previous computed cache is kept; the node stays invalid until a later successful run |
| Computed cycle / self-read    | `Reactive computed "id" cannot read itself while computing.`                                           |
| Recursive `effect.run()`      | `Reactive effect "id" cannot run itself recursively.`                                                  |
| Recursive `scheduler.flush()` | `Reactive scheduler cannot be flushed recursively.`                                                    |
| Cross-runtime dependency      | `Reactive dependency "producer" -> "consumer" cannot cross runtime boundaries.`                        |
| Duplicate reactive node ID    | `Reactive node "id" already exists.`                                                                   |
| Excessive computed depth      | `Reactive computation depth exceeded 1000.`                                                            |
| Missing graph node            | `Node "id" does not exist.`                                                                            |
| Cyclic topological sort       | `Cannot perform topological sort: graph contains a cycle.`                                             |

## Advanced API

These low-level types remain available, but application code should rarely use them directly:

- `ReactiveNode`, `ReactiveLink`, `ReactiveContext`, `Epoch`
- `GraphEdge`

Low-level reactive primitives use the explicit advanced entry point:

```ts
import {ReactiveNode} from 'grafyx/advanced';
```

Diagnostics (`inspect()`, `createGraphSnapshot()`) are for debugging, not the hot path.

## Scripts

```bash
npm test          # correctness suite (package tests + public API)
npm run test:coverage
npm run typecheck
npm run lint
npm run build     # production emit of packages/grafyx, tests excluded
npm run package:smoke
npm run ci        # lint + format + types + coverage + perf + build + package smoke
npm run bench     # local performance baseline
npm run bench:regression # executable CI performance budgets
npm run atlas       # open grafyx/atlas on this repository
```

[packages/atlas/README.md](packages/atlas/README.md) walks the map on a real project: the path and zoom in the header, the lenses, the order strip, Go deeper, and export.

CI runs `npm run ci` on `main` and pull requests.

## License

ISC
