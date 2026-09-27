/**
 * Devtools bridge.
 *
 * The bridge turns a runtime into a stream of versioned, JSON-serializable
 * messages and answers inspection requests. It is transport-agnostic: connect
 * `send` and `receive` to `postMessage`, a WebSocket, Electron IPC, or a test
 * harness. Requests can only run the read-only inspector tools.
 */

import {
  REACTIVE_EVENT_SCHEMA_VERSION,
  type ReactiveGraphMetrics,
  type ReactiveGraphSnapshot,
  type ReactiveRuntime,
  type ReactiveRuntimeEvent,
  type ReactiveRuntimePlugin,
  type ReactiveRuntimeState,
} from '../reactive/index.js';
import {callInspectorTool, createInspectorTools, type InspectorTool} from './inspector.js';

export const DEVTOOLS_PROTOCOL = 'grafyx-devtools';
export const DEVTOOLS_PROTOCOL_VERSION = 1;

interface DevtoolsEnvelope {
  readonly protocol: typeof DEVTOOLS_PROTOCOL;
  readonly version: typeof DEVTOOLS_PROTOCOL_VERSION;
  readonly runtimeId: string;
}

export interface DevtoolsSnapshot {
  readonly state: ReactiveRuntimeState;
  readonly metrics: ReactiveGraphMetrics;
  readonly graph: ReactiveGraphSnapshot;
}

export interface DevtoolsHelloMessage extends DevtoolsEnvelope {
  readonly type: 'hello';
  readonly schemaVersion: number;
  readonly tools: readonly string[];
  readonly snapshot: DevtoolsSnapshot;
}

export interface DevtoolsEventsMessage extends DevtoolsEnvelope {
  readonly type: 'events';
  readonly events: readonly ReactiveRuntimeEvent[];
  /** Events discarded because the outgoing queue was full. */
  readonly dropped: number;
}

export interface DevtoolsResponseMessage extends DevtoolsEnvelope {
  readonly type: 'response';
  readonly requestId: string;
  readonly ok: boolean;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
}

export interface DevtoolsGoodbyeMessage extends DevtoolsEnvelope {
  readonly type: 'goodbye';
}

/** Messages sent from the runtime to a devtools client. */
export type DevtoolsOutgoingMessage =
  DevtoolsHelloMessage | DevtoolsEventsMessage | DevtoolsResponseMessage | DevtoolsGoodbyeMessage;

/** Request sent from a devtools client to the runtime. */
export interface DevtoolsRequestMessage extends DevtoolsEnvelope {
  readonly type: 'request';
  readonly requestId: string;
  readonly tool: string;
  readonly input?: Record<string, unknown>;
}

export interface DevtoolsBridgeOptions {
  /** Identifies this runtime when several runtimes share one transport. */
  readonly runtimeId: string;
  /** Delivers a message to the devtools client. */
  readonly send: (message: DevtoolsOutgoingMessage) => void;
  /**
   * `microtask` (default) coalesces events emitted in the same task into one
   * message. `sync` sends each event immediately.
   */
  readonly delivery?: 'microtask' | 'sync';
  /** Maximum events buffered between deliveries. Defaults to 1,000. */
  readonly maxQueuedEvents?: number;
  /** Maximum items returned by list-like inspector tools. */
  readonly maxResults?: number;
}

export interface DevtoolsBridge extends ReactiveRuntimePlugin {
  /**
   * Handles a message from the devtools client. Messages for other
   * protocols or runtimes are ignored so a shared channel can be used.
   *
   * @returns `true` when the message was a request for this bridge.
   */
  receive(message: unknown): boolean;
}

function isRequestFor(message: unknown, runtimeId: string): message is DevtoolsRequestMessage {
  if (typeof message !== 'object' || message === null) return false;

  const candidate = message as Partial<DevtoolsRequestMessage>;

  return (
    candidate.protocol === DEVTOOLS_PROTOCOL &&
    candidate.version === DEVTOOLS_PROTOCOL_VERSION &&
    candidate.runtimeId === runtimeId &&
    candidate.type === 'request' &&
    typeof candidate.requestId === 'string' &&
    typeof candidate.tool === 'string'
  );
}

/**
 * Creates a devtools bridge plugin. Install it with `runtime.use(bridge)`,
 * then route incoming client messages to `bridge.receive()`.
 */
export function createDevtoolsBridge(options: DevtoolsBridgeOptions): DevtoolsBridge {
  const {runtimeId, send} = options;
  const delivery = options.delivery ?? 'microtask';
  const maxQueuedEvents = options.maxQueuedEvents ?? 1_000;

  if (!Number.isSafeInteger(maxQueuedEvents) || maxQueuedEvents < 1) {
    throw new RangeError('maxQueuedEvents must be a positive safe integer.');
  }

  const envelope = (): DevtoolsEnvelope => ({
    protocol: DEVTOOLS_PROTOCOL,
    version: DEVTOOLS_PROTOCOL_VERSION,
    runtimeId,
  });

  let tools: readonly InspectorTool[] | undefined;
  let queue: ReactiveRuntimeEvent[] = [];
  let dropped = 0;
  let flushScheduled = false;

  const flush = (): void => {
    flushScheduled = false;

    if (queue.length === 0 && dropped === 0) return;

    const events = queue;
    const droppedCount = dropped;
    queue = [];
    dropped = 0;
    send({...envelope(), type: 'events', events, dropped: droppedCount});
  };

  const enqueue = (event: ReactiveRuntimeEvent): void => {
    if (queue.length >= maxQueuedEvents) {
      queue.shift();
      dropped++;
    }

    queue.push(event);

    if (delivery === 'sync') {
      flush();
    } else if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(flush);
    }
  };

  const respond = (
    requestId: string,
    outcome: {ok: true; result: Record<string, unknown>} | {ok: false; error: string},
  ): void => {
    send({...envelope(), type: 'response', requestId, ...outcome});
  };

  return {
    name: `grafyx:devtools:${runtimeId}`,

    install(runtime: ReactiveRuntime) {
      tools = createInspectorTools(
        runtime,
        options.maxResults === undefined ? {} : {maxResults: options.maxResults},
      );

      send({
        ...envelope(),
        type: 'hello',
        schemaVersion: REACTIVE_EVENT_SCHEMA_VERSION,
        tools: tools.map((tool) => tool.name),
        snapshot: {
          state: runtime.state,
          metrics: runtime.getGraphMetrics(),
          graph: runtime.createGraphSnapshot(),
        },
      });

      const unsubscribe = runtime.subscribe(enqueue);

      return () => {
        unsubscribe();
        flush();
        tools = undefined;
        send({...envelope(), type: 'goodbye'});
      };
    },

    receive(message) {
      if (!isRequestFor(message, runtimeId)) return false;

      if (tools === undefined) {
        respond(message.requestId, {ok: false, error: 'Devtools bridge is not installed.'});
        return true;
      }

      try {
        respond(message.requestId, {
          ok: true,
          result: callInspectorTool(tools, message.tool, message.input),
        });
      } catch (error) {
        respond(message.requestId, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return true;
    },
  };
}
