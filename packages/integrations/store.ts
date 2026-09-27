/**
 * Framework-neutral store adapters.
 *
 * `createExternalStore` implements the `subscribe` / `getSnapshot` contract
 * accepted by React's `useSyncExternalStore`, and is the building block for
 * Vue, Solid, Svelte, and other UI integrations. The store only observes its
 * source while it has listeners, so unused stores hold no graph edges.
 */

import {
  ReactiveEffect,
  type ReactiveEffectScheduleHandle,
  type ReactiveEffectScheduler,
  type ReactiveRuntime,
} from '../reactive/index.js';

/** Any reactive value or computed. */
export interface ReactiveReadable<T> {
  readonly value: T;
  readonly node: {readonly id: string};
}

export interface ExternalStoreOptions {
  /** ID of the internal observer effect. Defaults to a unique derived ID. */
  readonly id?: string;
  /**
   * Scheduler for change notifications. Defaults to the runtime scheduler, so
   * listeners are notified on `runtime.flush()`. Use
   * `createMicrotaskScheduler()` for automatic UI updates.
   */
  readonly scheduler?: ReactiveEffectScheduler;
}

export interface ReactiveExternalStore<T> {
  /** Registers a change listener and returns an idempotent unsubscribe callback. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Returns the current value. Rethrows if the source computation fails. */
  readonly getSnapshot: () => T;
  readonly listenerCount: number;
  readonly disposed: boolean;
  /** Stops observing the source and removes every listener. */
  dispose(): void;
}

let storeSequence = 0;

/**
 * Creates an external store over a reactive value or computed.
 *
 * Listeners are notified when the source value changes by `Object.is`, and
 * when evaluating the source fails so the UI can read the error through
 * `getSnapshot()`.
 */
export function createExternalStore<T>(
  runtime: ReactiveRuntime,
  source: ReactiveReadable<T>,
  options: ExternalStoreOptions = {},
): ReactiveExternalStore<T> {
  const id = options.id ?? `grafyx:store:${source.node.id}:${++storeSequence}`;
  const listeners = new Set<() => void>();
  let observer: ReactiveEffect | undefined;
  let status: 'idle' | 'value' | 'error' = 'idle';
  let observedValue: T | undefined;
  let disposed = false;

  const notify = (): void => {
    // Listeners subscribed during notification wait for the next change.
    for (const listener of Array.from(listeners)) {
      listener();
    }
  };

  // The first observation only establishes the baseline; subscribers read the
  // initial value through getSnapshot().
  const observe = (): void => {
    const previousStatus = status;
    let next: T;

    try {
      next = source.value;
    } catch {
      status = 'error';
      if (previousStatus !== 'idle') notify();
      return;
    }

    if (previousStatus === 'value' && Object.is(observedValue, next)) return;

    status = 'value';
    observedValue = next;

    if (previousStatus !== 'idle') notify();
  };

  const stopObserving = (): void => {
    observer?.dispose();
    observer = undefined;
    status = 'idle';
    observedValue = undefined;
  };

  return {
    subscribe: (listener) => {
      if (disposed) {
        throw new Error(`Reactive store "${id}" has been disposed.`);
      }

      listeners.add(listener);

      if (observer === undefined) {
        observer = new ReactiveEffect(runtime, id, observe, options.scheduler);
        observer.run();
      }

      let subscribed = true;

      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);

        if (listeners.size === 0) stopObserving();
      };
    },

    getSnapshot: () => source.value,

    get listenerCount() {
      return listeners.size;
    },

    get disposed() {
      return disposed;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      stopObserving();
    },
  };
}

/** The Svelte store contract. */
export interface SvelteReadable<T> {
  subscribe(run: (value: T) => void): () => void;
}

/**
 * Adapts an external store to the Svelte store contract, which delivers the
 * current value immediately and after every change.
 */
export function toSvelteStore<T>(store: ReactiveExternalStore<T>): SvelteReadable<T> {
  return {
    subscribe(run) {
      const unsubscribe = store.subscribe(() => run(store.getSnapshot()));
      run(store.getSnapshot());
      return unsubscribe;
    },
  };
}

/**
 * Creates an effect scheduler that runs each task in a microtask.
 *
 * Errors thrown by a task are passed to `onError`; without a handler they are
 * rethrown asynchronously and surface as uncaught exceptions.
 */
export function createMicrotaskScheduler(
  onError?: (error: unknown) => void,
): ReactiveEffectScheduler {
  return {
    schedule(task): ReactiveEffectScheduleHandle {
      let cancelled = false;

      queueMicrotask(() => {
        if (cancelled) return;

        try {
          task();
        } catch (error) {
          if (onError === undefined) throw error;
          onError(error);
        }
      });

      return {
        cancel() {
          cancelled = true;
        },
      };
    },
  };
}
