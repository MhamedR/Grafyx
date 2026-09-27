/**
 * Read-only, transport-agnostic inspection tools for a reactive runtime.
 *
 * Every tool accepts a JSON object, validates it against its published JSON
 * Schema, and returns a JSON-serializable object. The same tools back MCP
 * servers, devtools, and command-line inspectors. No tool mutates the runtime.
 */

import {
  REACTIVE_EVENT_SCHEMA_VERSION,
  type ReactiveRuntime,
  type ReactiveRuntimeEvent,
} from '../reactive/index.js';

/** JSON Schema subset used to describe tool input. */
export interface InspectorInputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface InspectorTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: InspectorInputSchema;
  call(input?: unknown): Record<string, unknown>;
}

export interface InspectorOptions {
  /** Upper bound for items returned by list-like tools. Defaults to 200. */
  readonly maxResults?: number;
}

/** Thrown when tool input does not match the tool's schema. */
export class InspectorInputError extends TypeError {
  override readonly name = 'InspectorInputError';
}

const EVENT_TYPES = [
  'node-registered',
  'node-disposed',
  'node-changed',
  'node-invalidated',
  'batch-started',
  'batch-completed',
  'computation-started',
  'computation-completed',
] as const satisfies readonly ReactiveRuntimeEvent['type'][];

const NODE_KINDS = ['value', 'computed', 'effect'] as const;

type Input = Readonly<Record<string, unknown>>;

function readInput(tool: string, input: unknown, allowed: readonly string[]): Input {
  if (input === undefined || input === null) return {};

  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new InspectorInputError(`${tool}: input must be an object.`);
  }

  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new InspectorInputError(`${tool}: unknown input property "${key}".`);
    }
  }

  return input as Input;
}

function optionalString(tool: string, input: Input, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string')
    throw new InspectorInputError(`${tool}: "${key}" must be a string.`);
  return value;
}

function requiredString(tool: string, input: Input, key: string): string {
  const value = optionalString(tool, input, key);
  if (value === undefined) throw new InspectorInputError(`${tool}: "${key}" is required.`);
  return value;
}

function optionalBoolean(tool: string, input: Input, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean')
    throw new InspectorInputError(`${tool}: "${key}" must be a boolean.`);
  return value;
}

function optionalInteger(
  tool: string,
  input: Input,
  key: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;

  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new InspectorInputError(
      `${tool}: "${key}" must be an integer between ${minimum} and ${maximum}.`,
    );
  }

  return value;
}

function optionalEnum<const T extends string>(
  tool: string,
  input: Input,
  key: string,
  values: readonly T[],
): T | undefined {
  const value = input[key];
  if (value === undefined) return undefined;

  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new InspectorInputError(`${tool}: "${key}" must be one of ${values.join(', ')}.`);
  }

  return value as T;
}

function optionalEnumArray<const T extends string>(
  tool: string,
  input: Input,
  key: string,
  values: readonly T[],
): readonly T[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;

  if (!Array.isArray(value) || value.some((item) => !values.includes(item as T))) {
    throw new InspectorInputError(`${tool}: "${key}" must contain only ${values.join(', ')}.`);
  }

  return value as T[];
}

function eventNodeId(event: ReactiveRuntimeEvent): string | undefined {
  return 'nodeId' in event ? event.nodeId : undefined;
}

/**
 * Creates the read-only inspection tools for one runtime.
 */
export function createInspectorTools(
  runtime: ReactiveRuntime,
  options: InspectorOptions = {},
): readonly InspectorTool[] {
  const maxResults = options.maxResults ?? 200;

  if (!Number.isSafeInteger(maxResults) || maxResults < 1) {
    throw new RangeError('maxResults must be a positive safe integer.');
  }

  const limitSchema = {type: 'integer', minimum: 1, maximum: maxResults};

  const describe: InspectorTool = {
    name: 'grafyx_describe',
    title: 'Describe reactive runtime',
    description:
      'Returns runtime scheduler and batch state, aggregate graph metrics, installed plugins, and the event schema version.',
    inputSchema: {type: 'object', properties: {}, additionalProperties: false},
    call(input) {
      readInput(this.name, input, []);

      return {
        schemaVersion: REACTIVE_EVENT_SCHEMA_VERSION,
        disposed: runtime.disposed,
        state: runtime.state,
        metrics: runtime.getGraphMetrics(),
        plugins: runtime.pluginNames,
      };
    },
  };

  const listNodes: InspectorTool = {
    name: 'grafyx_list_nodes',
    title: 'List reactive nodes',
    description:
      'Lists registered reactive nodes with their kind, version, dirty state, and dependency counts. Supports filtering by kind, dirty state, and ID prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {type: 'string', enum: NODE_KINDS},
        dirty: {type: 'boolean'},
        idPrefix: {type: 'string'},
        limit: limitSchema,
      },
      additionalProperties: false,
    },
    call(input) {
      const args = readInput(this.name, input, ['kind', 'dirty', 'idPrefix', 'limit']);
      const kind = optionalEnum(this.name, args, 'kind', NODE_KINDS);
      const dirty = optionalBoolean(this.name, args, 'dirty');
      const idPrefix = optionalString(this.name, args, 'idPrefix');
      const limit = optionalInteger(this.name, args, 'limit', 1, maxResults) ?? maxResults;

      const matches = runtime
        .createGraphSnapshot()
        .nodes.filter(
          (node) =>
            (kind === undefined || node.kind === kind) &&
            (dirty === undefined || node.dirty === dirty) &&
            (idPrefix === undefined || node.id.startsWith(idPrefix)),
        );

      return {
        total: matches.length,
        truncated: matches.length > limit,
        nodes: matches.slice(0, limit),
      };
    },
  };

  const explain: InspectorTool = {
    name: 'grafyx_explain',
    title: 'Explain a reactive node',
    description:
      'Explains one node: its state, direct producers and consumers, and the source-to-node path that most recently invalidated it.',
    inputSchema: {
      type: 'object',
      properties: {nodeId: {type: 'string'}},
      required: ['nodeId'],
      additionalProperties: false,
    },
    call(input) {
      const args = readInput(this.name, input, ['nodeId']);
      return {...runtime.explain(requiredString(this.name, args, 'nodeId'))};
    },
  };

  const dependencies: InspectorTool = {
    name: 'grafyx_dependencies',
    title: 'Walk reactive dependencies',
    description:
      'Returns the transitive upstream producers or downstream consumers of a node, breadth first, with their distance from the node.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: {type: 'string'},
        direction: {type: 'string', enum: ['upstream', 'downstream']},
        maxDepth: {type: 'integer', minimum: 1},
        limit: limitSchema,
      },
      required: ['nodeId', 'direction'],
      additionalProperties: false,
    },
    call(input) {
      const args = readInput(this.name, input, ['nodeId', 'direction', 'maxDepth', 'limit']);
      const nodeId = requiredString(this.name, args, 'nodeId');
      const direction = optionalEnum(this.name, args, 'direction', ['upstream', 'downstream']);
      const maxDepth = optionalInteger(this.name, args, 'maxDepth', 1) ?? Number.POSITIVE_INFINITY;
      const limit = optionalInteger(this.name, args, 'limit', 1, maxResults) ?? maxResults;

      if (direction === undefined) {
        throw new InspectorInputError(`${this.name}: "direction" is required.`);
      }

      const neighbours = (id: string): readonly string[] => {
        const explanation = runtime.explain(id);
        return direction === 'upstream' ? explanation.producerIds : explanation.consumerIds;
      };

      const visited = new Set([nodeId]);
      const nodes: {id: string; depth: number}[] = [];
      let frontier = [nodeId];
      let truncated = false;

      for (let depth = 1; frontier.length > 0 && depth <= maxDepth && !truncated; depth++) {
        const next: string[] = [];

        for (const id of frontier) {
          for (const neighbour of neighbours(id)) {
            if (visited.has(neighbour)) continue;

            if (nodes.length === limit) {
              truncated = true;
              break;
            }

            visited.add(neighbour);
            nodes.push({id: neighbour, depth});
            next.push(neighbour);
          }

          if (truncated) break;
        }

        frontier = next;
      }

      return {nodeId, direction, truncated, nodes};
    },
  };

  const trace: InspectorTool = {
    name: 'grafyx_trace',
    title: 'Read runtime trace',
    description:
      'Returns retained runtime events after a sequence cursor, optionally filtered by event type or node ID. Requires the runtime to be created with a traceBufferSize.',
    inputSchema: {
      type: 'object',
      properties: {
        sinceSequence: {type: 'integer', minimum: 0},
        types: {type: 'array', items: {type: 'string', enum: EVENT_TYPES}},
        nodeId: {type: 'string'},
        limit: limitSchema,
      },
      additionalProperties: false,
    },
    call(input) {
      const args = readInput(this.name, input, ['sinceSequence', 'types', 'nodeId', 'limit']);
      const sinceSequence = optionalInteger(this.name, args, 'sinceSequence', 0) ?? 0;
      const types = optionalEnumArray(this.name, args, 'types', EVENT_TYPES);
      const nodeId = optionalString(this.name, args, 'nodeId');
      const limit = optionalInteger(this.name, args, 'limit', 1, maxResults) ?? maxResults;

      const matches = runtime
        .getTrace({sinceSequence})
        .filter(
          (event) =>
            (types === undefined || types.includes(event.type)) &&
            (nodeId === undefined || eventNodeId(event) === nodeId),
        );

      return {
        schemaVersion: REACTIVE_EVENT_SCHEMA_VERSION,
        latestSequence: runtime.state.eventSequence,
        retainedEventCount: runtime.state.traceEventCount,
        truncated: matches.length > limit,
        events: matches.slice(0, limit),
      };
    },
  };

  const snapshot: InspectorTool = {
    name: 'grafyx_snapshot',
    title: 'Snapshot reactive graph',
    description:
      'Returns a detached snapshot of reactive nodes and dependency edges, bounded by the limit.',
    inputSchema: {
      type: 'object',
      properties: {limit: limitSchema},
      additionalProperties: false,
    },
    call(input) {
      const args = readInput(this.name, input, ['limit']);
      const limit = optionalInteger(this.name, args, 'limit', 1, maxResults) ?? maxResults;
      const graph = runtime.createGraphSnapshot();
      const nodes = graph.nodes.slice(0, limit);
      const included = new Set(nodes.map((node) => node.id));
      const edges = graph.edges.filter(
        (edge) => included.has(edge.producerId) && included.has(edge.consumerId),
      );

      return {
        truncated: graph.nodes.length > limit,
        totalNodes: graph.nodes.length,
        totalEdges: graph.edges.length,
        nodes,
        edges,
      };
    },
  };

  return [describe, listNodes, explain, dependencies, trace, snapshot].map((tool) =>
    Object.freeze({...tool, call: tool.call.bind(tool)}),
  );
}

/**
 * Finds and invokes a tool by name.
 *
 * @throws {InspectorInputError} If no tool has the given name or the input is invalid.
 */
export function callInspectorTool(
  tools: readonly InspectorTool[],
  name: string,
  input?: unknown,
): Record<string, unknown> {
  const tool = tools.find((candidate) => candidate.name === name);

  if (tool === undefined) {
    throw new InspectorInputError(`Unknown inspector tool "${name}".`);
  }

  return tool.call(input);
}

/** Tool definition in the shape returned by an MCP `tools/list` response. */
export interface McpToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: InspectorInputSchema;
  readonly annotations: {
    readonly readOnlyHint: true;
    readonly destructiveHint: false;
    readonly idempotentHint: true;
    readonly openWorldHint: false;
  };
}

/** Result in the shape expected from an MCP `tools/call` handler. */
export interface McpToolResult {
  [key: string]: unknown;
  readonly content: readonly {readonly type: 'text'; readonly text: string}[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

/**
 * Converts inspector tools to MCP tool definitions.
 */
export function toMcpTools(tools: readonly InspectorTool[]): McpToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }));
}

/**
 * Handles MCP `tools/call` parameters.
 *
 * Input and runtime errors become tool results with `isError: true`, as the
 * MCP specification requires, so a model can read and correct them.
 */
export function callMcpTool(
  tools: readonly InspectorTool[],
  params: {readonly name: string; readonly arguments?: Record<string, unknown> | undefined},
): McpToolResult {
  try {
    const structuredContent = callInspectorTool(tools, params.name, params.arguments);

    return {
      content: [{type: 'text', text: JSON.stringify(structuredContent)}],
      structuredContent,
    };
  } catch (error) {
    return {
      content: [{type: 'text', text: error instanceof Error ? error.message : String(error)}],
      isError: true,
    };
  }
}
