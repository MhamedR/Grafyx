# Public API

Grafyx is ESM-only and supports Node.js 20 and newer. Public APIs are
available through eight package entry points: the root, `graph`, `reactive`,
`advanced`, and the integration subpaths `opentelemetry`, `inspector`,
`devtools`, and `store`. Integration recipes are in [RECIPES.md](RECIPES.md).

## `grafyx`

The package root combines the stable graph and reactive application APIs. It
does not export low-level reactive graph primitives.

## `grafyx/graph`

### Classes

- `Node<T>` — a string ID and typed payload. The payload may be omitted only
  when `T` is `string`.
- `GraphEdge` — a graph-owned directed relationship returned by `getEdge`.
- `DirectedGraph<T>` — mutable directed graph with mirrored incoming and
  outgoing adjacency indexes.

### Algorithms

- `breadthFirstSearch`
- `depthFirstSearch`
- `getAncestors`
- `getDescendants`
- `getReachableNodes`
- `hasCycle`
- `hasPath`
- `stronglyConnectedComponents`
- `topologicalSort`

Algorithms return `Node<T>` instances and throw when a required node ID is
missing. Topological sorting throws for cyclic graphs.

## `grafyx/reactive`

### Application classes

- `ReactiveRuntime` — owns node identity, scheduling, batching, inspection,
  and lifecycle.
- `ReactiveValue<T>` — writable source with configurable equality.
- `ReactiveComputed<T>` — lazy cached computation with dynamic dependencies.
- `ReactiveEffect` — scheduled side effect with dynamic dependencies.
- `ReactiveScheduler` — deterministic FIFO scheduler.
- `ManualEffectScheduler` — manually flushed scheduler for adapters and tests.
- `AsyncReactiveScheduler` — sequential FIFO scheduler for explicitly
  asynchronous work.

### Extension contracts

- `ReactiveEffectScheduler`
- `ReactiveEffectScheduleHandle`

### Diagnostics

- `ReactiveRuntime.inspect()`
- `ReactiveRuntime.createGraphSnapshot()`
- `ReactiveRuntime.getGraphMetrics()`
- `ReactiveRuntime.describe()`
- `ReactiveRuntime.explain(nodeId)`
- `ReactiveRuntime.subscribe(listener)`
- `ReactiveRuntime.getTrace(query?)`
- `ReactiveRuntime.clearTrace()`
- `ReactiveRuntime.isObserved`
- `diffReactiveGraphSnapshots()`

### Plugins

- `ReactiveRuntime.use(plugin)` installs a `ReactiveRuntimePlugin` and returns
  an idempotent uninstall callback. Names must be unique per runtime.
- `ReactiveRuntime.pluginNames` lists installed plugins in order.
- Plugin cleanup runs in reverse installation order on uninstall or runtime
  disposal, after nodes are disposed. Cleanup errors are rethrown by
  `dispose()` after every plugin has been cleaned up.

Pass `{traceBufferSize}` to `ReactiveRuntime` to retain a bounded event history.
Without a buffer or live subscriber, event creation and timestamp collection
are disabled. Live listener failures are isolated and counted in runtime state.
`explain()` remains available without tracing and returns the most recent
source-to-node invalidation path; its reason sequence is undefined when no
matching event was emitted.

Runtime event types are `node-registered`, `node-disposed`, `node-changed`,
`node-invalidated`, `batch-started`, `batch-completed`, `computation-started`,
and `computation-completed`. Computation events cover each computed evaluation
and effect run; completions reference their start by `startedSequence` and
carry `durationMs`, `status`, `valueChanged` (computeds), and `error`.

The event shapes are versioned by `REACTIVE_EVENT_SCHEMA_VERSION` (currently
`1`). New event types and fields may be added within a version; removing or
changing a field increments it. Consumers should ignore unknown event types.

Listeners run with dependency tracking suspended. Observing a runtime adds
event construction and timing to every computation, roughly doubling
recomputation cost on Node.js 24 in the regression suite; unobserved runtimes
skip that work.

Snapshots include node kinds. Snapshot diffs distinguish added, removed, and
changed edges; an edge is changed when its captured version or stale state
changes. Diagnostic snapshots are detached values intended for debugging
rather than hot-path execution.

## `grafyx/advanced`

The advanced entry point contains low-level reactive graph primitives:

- `ReactiveNode`
- `ReactiveLink`
- `ReactiveContext`
- `Epoch`

Use this subpath only when implementing adapters or runtime extensions. Its
surface is explicit and contract-tested, but changes require more care than
the application API.

## Integration subpaths

All integrations are dependency-free and use only the public reactive API.

### `grafyx/opentelemetry`

- `createOpenTelemetryPlugin({tracer, parentContext?, recordInvalidations?, name?})`
  exports batches and computations as spans. `tracer` is structurally typed
  against OpenTelemetry's `Tracer`.

### `grafyx/inspector`

- `createInspectorTools(runtime, {maxResults?})` returns six read-only tools
  with JSON Schema input: `grafyx_describe`, `grafyx_list_nodes`,
  `grafyx_explain`, `grafyx_dependencies`, `grafyx_trace`,
  and `grafyx_snapshot`.
- `callInspectorTool(tools, name, input)` validates and runs a tool, throwing
  `InspectorInputError` on invalid input.
- `toMcpTools(tools)` and `callMcpTool(tools, params)` produce MCP `tools/list`
  definitions and `tools/call` results. Failures become `isError` results.

### `grafyx/devtools`

- `createDevtoolsBridge({runtimeId, send, delivery?, maxQueuedEvents?, maxResults?})`
  returns a plugin with `receive(message)`. The protocol is identified by
  `DEVTOOLS_PROTOCOL` and `DEVTOOLS_PROTOCOL_VERSION`; messages are `hello`,
  `events`, `response`, and `goodbye`, and clients send `request`.

### `grafyx/store`

- `createExternalStore(runtime, source, {id?, scheduler?})` returns
  `{subscribe, getSnapshot, listenerCount, disposed, dispose}` compatible with
  React's `useSyncExternalStore`. The store observes its source only while it
  has listeners.
- `toSvelteStore(store)` adapts a store to the Svelte store contract.
- `createMicrotaskScheduler(onError?)` notifies without explicit flushing.

## Reactive constraints

- Node IDs are unique within one runtime.
- Dependencies cannot cross runtime boundaries.
- Evaluation and dependency tracking are synchronous.
- Synchronous schedulers reject promise-returning tasks. Use
  `AsyncReactiveScheduler` when tasks must be awaited.
- Computed evaluation is limited to 1,000 nested computeds.
- Effects run only through `run()` or their configured scheduler.
- Disposing a runtime disposes registered values, computeds, effects, custom
  scheduled work, and pending node changes.
