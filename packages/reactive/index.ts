/**
 * Public reactive API.
 *
 * Application API:
 * - ReactiveRuntime, ReactiveValue, ReactiveComputed, ReactiveEffect
 * - ReactiveScheduler, ManualEffectScheduler, scheduler types
 * - runtime diagnostics and graph snapshots
 *
 * Low-level graph primitives are published separately from
 * `grafyx/advanced`.
 */

export {
  ReactiveRuntime,
  type ReactiveGraphMetrics,
  type ReactiveNodeInspection,
  type ReactiveRuntimeInspection,
  type ReactiveRuntimeState,
} from './reactive-runtime.js';

export {ReactiveValue} from './reactive-value.js';
export {ReactiveComputed} from './reactive-computed.js';
export {ReactiveEffect} from './reactive-effect.js';

export {ReactiveScheduler} from './scheduler.js';
export {ManualEffectScheduler} from './manual-effect-scheduler.js';
export {AsyncReactiveScheduler, type AsyncScheduledTask} from './async-reactive-scheduler.js';
export type {
  ReactiveEffectScheduleHandle,
  ReactiveEffectScheduler,
} from './reactive-scheduler-options.js';

export {
  type ReactiveGraphSnapshot,
  type ReactiveGraphSnapshotEdge,
  type ReactiveGraphSnapshotNode,
} from './reactive-graph-snapshot.js';
export {
  diffReactiveGraphSnapshots,
  type ReactiveGraphSnapshotDiff,
  type ReactiveGraphSnapshotEdgeChange,
  type ReactiveGraphSnapshotNodeChange,
} from './reactive-graph-diff.js';

export {
  REACTIVE_EVENT_SCHEMA_VERSION,
  type ReactiveBatchCompletedEvent,
  type ReactiveBatchStartedEvent,
  type ReactiveComputationCompletedEvent,
  type ReactiveComputationKind,
  type ReactiveComputationStartedEvent,
  type ReactiveInvalidationReason,
  type ReactiveNodeChangedEvent,
  type ReactiveNodeDisposedEvent,
  type ReactiveNodeExplanation,
  type ReactiveNodeInvalidatedEvent,
  type ReactiveNodeRegisteredEvent,
  type ReactiveRuntimeEvent,
  type ReactiveRuntimeEventListener,
  type ReactiveRuntimeEventType,
  type ReactiveRuntimeOptions,
  type ReactiveRuntimePlugin,
  type ReactiveTraceQuery,
} from './reactive-events.js';
