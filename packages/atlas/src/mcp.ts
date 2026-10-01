/**
 * Read-only MCP tools for grafyx/atlas.
 *
 * The same tools back `grafyx-atlas --mcp` and a host that wires
 * `grafyx-atlas/mcp` into its own server. Importing this module does not
 * listen. Tools scan a project root and answer the lenses: map, impact,
 * upstream, cycles, order, stats, and go deeper.
 */

import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Readable, Writable} from 'node:stream';
import {extractProject} from './extract-project.js';
import {extractSourceFocus} from './extract-source.js';
import {
  CYCLE_CLEAR,
  LENS_QUESTION,
  SOURCE_LENS_QUESTION,
  formatBytes,
  nodeBytes,
  nodeCaption,
  nodeShape,
  type AtlasSnapshot,
  type PackageNode,
} from './model.js';
import {parseCommand} from './session.js';
import {
  buildPackageGraph,
  cycles,
  degrees,
  downstream,
  order,
  path,
  relationOf,
  upstream,
} from './structural.js';
import {structureStats} from './stats.js';

/** JSON Schema subset used to describe tool input. */
export interface AtlasMcpInputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface AtlasMcpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: AtlasMcpInputSchema;
  call(input?: unknown): Promise<Record<string, unknown>>;
}

export interface AtlasMcpOptions {
  /** Project to scan when a tool omits `root`. Defaults to the current directory. */
  readonly root?: string;
  readonly extract?: (root: string) => Promise<AtlasSnapshot>;
  readonly focus?: (root: string, nodePath: string) => Promise<AtlasSnapshot | null>;
}

/** Thrown when tool input does not match the tool's schema. */
export class AtlasMcpInputError extends TypeError {
  override readonly name = 'AtlasMcpInputError';
}

/** Tool definition in the shape returned by an MCP `tools/list` response. */
export interface McpToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: AtlasMcpInputSchema;
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

export interface AtlasMcpConnection {
  close(): void;
}

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const DEFAULT_PROTOCOL = '2025-03-26';
const SERVER_NAME = 'grafyx-atlas';
const PART_HINT_LIMIT = 20;

type Input = Readonly<Record<string, unknown>>;
type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: JsonRpcId;
  readonly method?: unknown;
  readonly params?: unknown;
}

const MCP_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const ROOT_PROPERTY = {
  type: 'string',
  description: 'Project to scan. Defaults to the server root, then the current directory.',
};

const REFRESH_PROPERTY = {
  type: 'boolean',
  description: 'Rescan the project instead of reusing the last snapshot for this root.',
};

const ID_PROPERTY = {
  type: 'string',
  description: 'Part id on the map. A unique prefix is enough.',
};

function packageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    version?: string;
  };
  return manifest.version ?? '0.0.0';
}

function question(
  snapshot: AtlasSnapshot,
  lens: 'map' | 'impact' | 'upstream' | 'cycles' | 'order',
): string {
  return snapshot.kind === 'source' ? SOURCE_LENS_QUESTION[lens] : LENS_QUESTION[lens];
}

function readInput(tool: string, input: unknown, allowed: readonly string[]): Input {
  if (input === undefined || input === null) return {};

  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new AtlasMcpInputError(`${tool}: input must be an object.`);
  }

  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new AtlasMcpInputError(`${tool}: unknown input property "${key}".`);
    }
  }

  return input as Input;
}

function optionalString(tool: string, input: Input, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new AtlasMcpInputError(`${tool}: "${key}" must be a string.`);
  }
  return value;
}

function requiredString(tool: string, input: Input, key: string): string {
  const value = optionalString(tool, input, key);
  if (value === undefined || value.trim().length === 0) {
    throw new AtlasMcpInputError(`${tool}: "${key}" is required.`);
  }
  return value;
}

function optionalBoolean(tool: string, input: Input, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new AtlasMcpInputError(`${tool}: "${key}" must be a boolean.`);
  }
  return value;
}

function resolvePartId(snapshot: AtlasSnapshot, token: string): string {
  const ids = snapshot.nodes.map((node) => node.id);
  const exact = ids.find((id) => id === token || id.toLowerCase() === token.toLowerCase());
  if (exact) return exact;

  const parsed = parseCommand(token, ids);
  if (parsed.packageId) return parsed.packageId;

  const hint = ids.slice(0, PART_HINT_LIMIT).join(', ');
  const more = ids.length > PART_HINT_LIMIT ? ', …' : '';
  throw new AtlasMcpInputError(
    ids.length === 0
      ? `Unknown part "${token}". This root has no parts.`
      : `Unknown part "${token}". Parts: ${hint}${more}.`,
  );
}

function nodeOf(snapshot: AtlasSnapshot, id: string): PackageNode {
  const node = snapshot.nodes.find((item) => item.id === id);
  if (!node) throw new AtlasMcpInputError(`Unknown part "${id}".`);
  return node;
}

function summarizeNode(snapshot: AtlasSnapshot, node: PackageNode): Record<string, unknown> {
  const shape = nodeShape(snapshot.kind ?? 'workspace', node);
  const files = node.files ?? [];
  return {
    id: node.id,
    path: node.path,
    description: node.description,
    shape,
    files: files.length,
    bytes: nodeBytes(node),
    caption: nodeCaption(node, shape),
  };
}

/**
 * Creates the atlas tools for one default project root.
 *
 * Snapshots are cached per resolved root until a tool passes `refresh: true`.
 */
export function createAtlasMcpTools(options: AtlasMcpOptions = {}): readonly AtlasMcpTool[] {
  const defaultRoot = resolve(options.root ?? process.cwd());
  const extract = options.extract ?? extractProject;
  const focus = options.focus ?? extractSourceFocus;
  const cache = new Map<string, AtlasSnapshot>();

  async function load(
    tool: string,
    input: Input,
  ): Promise<{root: string; snapshot: AtlasSnapshot}> {
    const root = resolve(optionalString(tool, input, 'root') ?? defaultRoot);
    const refresh = optionalBoolean(tool, input, 'refresh') === true;
    const cached = cache.get(root);
    if (cached && !refresh) return {root, snapshot: cached};

    const snapshot = await extract(root);
    cache.set(root, snapshot);
    return {root, snapshot};
  }

  const map: AtlasMcpTool = {
    name: 'atlas_map',
    title: 'Atlas map',
    description:
      'Scans a project and returns the structure map: parts, dependency edges, and scan cost. A workspace of several packages becomes a package graph; a single project becomes its source tree.',
    inputSchema: {
      type: 'object',
      properties: {root: ROOT_PROPERTY, refresh: REFRESH_PROPERTY},
      additionalProperties: false,
    },
    async call(input) {
      const args = readInput(this.name, input, ['root', 'refresh']);
      const {root, snapshot} = await load(this.name, args);
      return {
        question: question(snapshot, 'map'),
        root,
        kind: snapshot.kind ?? 'workspace',
        extractedAt: snapshot.extractedAt,
        scan: snapshot.scan ?? null,
        nodes: snapshot.nodes.map((node) => summarizeNode(snapshot, node)),
        edges: snapshot.edges.map((edge) => ({
          from: edge.from,
          to: edge.to,
          relation: edge.relation,
        })),
      };
    },
  };

  const impact: AtlasMcpTool = {
    name: 'atlas_impact',
    title: 'Atlas impact',
    description:
      'What must change if this part changes: every downstream part on the map, in dependency order.',
    inputSchema: {
      type: 'object',
      properties: {id: ID_PROPERTY, root: ROOT_PROPERTY, refresh: REFRESH_PROPERTY},
      required: ['id'],
      additionalProperties: false,
    },
    async call(input) {
      const args = readInput(this.name, input, ['id', 'root', 'refresh']);
      const {snapshot} = await load(this.name, args);
      const id = resolvePartId(snapshot, requiredString(this.name, args, 'id'));
      const reached = downstream(buildPackageGraph(snapshot), id);
      return {question: question(snapshot, 'impact'), id, reached};
    },
  };

  const upstreamOf: AtlasMcpTool = {
    name: 'atlas_upstream',
    title: 'Atlas upstream',
    description: 'What this part stands on: every upstream part on the map.',
    inputSchema: {
      type: 'object',
      properties: {id: ID_PROPERTY, root: ROOT_PROPERTY, refresh: REFRESH_PROPERTY},
      required: ['id'],
      additionalProperties: false,
    },
    async call(input) {
      const args = readInput(this.name, input, ['id', 'root', 'refresh']);
      const {snapshot} = await load(this.name, args);
      const id = resolvePartId(snapshot, requiredString(this.name, args, 'id'));
      const stoodOn = upstream(buildPackageGraph(snapshot), id);
      return {question: question(snapshot, 'upstream'), id, stoodOn};
    },
  };

  const loops: AtlasMcpTool = {
    name: 'atlas_cycles',
    title: 'Atlas cycles',
    description: 'Where the order is impossible: import or workspace-dependency loops.',
    inputSchema: {
      type: 'object',
      properties: {root: ROOT_PROPERTY, refresh: REFRESH_PROPERTY},
      additionalProperties: false,
    },
    async call(input) {
      const args = readInput(this.name, input, ['root', 'refresh']);
      const {snapshot} = await load(this.name, args);
      const found = cycles(buildPackageGraph(snapshot));
      return {
        question: found.length === 0 ? CYCLE_CLEAR : question(snapshot, 'cycles'),
        cycles: found,
      };
    },
  };

  const schedule: AtlasMcpTool = {
    name: 'atlas_order',
    title: 'Atlas build order',
    description:
      'The schedule the ranks follow. When the graph has a loop, returns the strongly connected components instead.',
    inputSchema: {
      type: 'object',
      properties: {root: ROOT_PROPERTY, refresh: REFRESH_PROPERTY},
      additionalProperties: false,
    },
    async call(input) {
      const args = readInput(this.name, input, ['root', 'refresh']);
      const {snapshot} = await load(this.name, args);
      const result = order(buildPackageGraph(snapshot));
      if (result.kind === 'cycle') {
        return {
          question: question(snapshot, 'cycles'),
          kind: result.kind,
          components: result.components,
        };
      }
      return {question: question(snapshot, 'order'), kind: result.kind, ids: result.ids};
    },
  };

  const stats: AtlasMcpTool = {
    name: 'atlas_stats',
    title: 'Atlas stats',
    description:
      'Where the weight sits and how far a change reaches: largest files, weight by part, blast radius, and direct coupling.',
    inputSchema: {
      type: 'object',
      properties: {root: ROOT_PROPERTY, refresh: REFRESH_PROPERTY},
      additionalProperties: false,
    },
    async call(input) {
      const args = readInput(this.name, input, ['root', 'refresh']);
      const {snapshot} = await load(this.name, args);
      const chart = structureStats(snapshot);
      return {
        scan: chart.scan,
        totals: {
          ...chart.totals,
          size: formatBytes(chart.totals.bytes),
        },
        largestFiles: chart.largestFiles.map((file) => ({
          ...file,
          size: formatBytes(file.bytes),
        })),
        weight: chart.weight.map((item) => ({...item, size: formatBytes(item.bytes)})),
        blast: chart.blast,
        coupling: chart.coupling,
      };
    },
  };

  const deeper: AtlasMcpTool = {
    name: 'atlas_focus',
    title: 'Atlas go deeper',
    description:
      'Opens one folder on a source map: the files inside it and the files one import away. Pass a part id or its path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Part id or source path, for example services or src/services.',
        },
        root: ROOT_PROPERTY,
        refresh: REFRESH_PROPERTY,
      },
      required: ['path'],
      additionalProperties: false,
    },
    async call(input) {
      const args = readInput(this.name, input, ['path', 'root', 'refresh']);
      const {root, snapshot} = await load(this.name, args);
      const token = requiredString(this.name, args, 'path');
      const byId = snapshot.nodes.find(
        (node) => node.id === token || node.id.toLowerCase() === token.toLowerCase(),
      );
      const nodePath = byId?.path ?? token;
      const focused = await focus(root, nodePath);
      if (!focused) {
        throw new AtlasMcpInputError(`Cannot go deeper into "${token}".`);
      }
      return {
        question: question(focused, 'map'),
        path: nodePath,
        kind: focused.kind ?? 'source',
        nodes: focused.nodes.map((node) => summarizeNode(focused, node)),
        edges: focused.edges.map((edge) => ({
          from: edge.from,
          to: edge.to,
          relation: edge.relation,
        })),
      };
    },
  };

  const route: AtlasMcpTool = {
    name: 'atlas_path',
    title: 'Atlas path',
    description: 'One path from the part that must exist first to the part that depends on it.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {type: 'string', description: 'Start part, the thing that must exist first.'},
        to: {type: 'string', description: 'End part, the thing that comes after.'},
        root: ROOT_PROPERTY,
        refresh: REFRESH_PROPERTY,
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    async call(input) {
      const args = readInput(this.name, input, ['from', 'to', 'root', 'refresh']);
      const {snapshot} = await load(this.name, args);
      const from = resolvePartId(snapshot, requiredString(this.name, args, 'from'));
      const to = resolvePartId(snapshot, requiredString(this.name, args, 'to'));
      return {from, to, path: path(buildPackageGraph(snapshot), from, to)};
    },
  };

  const part: AtlasMcpTool = {
    name: 'atlas_part',
    title: 'Atlas part',
    description: 'One part: its files, size, direct neighbours, and in/out degree.',
    inputSchema: {
      type: 'object',
      properties: {id: ID_PROPERTY, root: ROOT_PROPERTY, refresh: REFRESH_PROPERTY},
      required: ['id'],
      additionalProperties: false,
    },
    async call(input) {
      const args = readInput(this.name, input, ['id', 'root', 'refresh']);
      const {snapshot} = await load(this.name, args);
      const id = resolvePartId(snapshot, requiredString(this.name, args, 'id'));
      const node = nodeOf(snapshot, id);
      const structure = buildPackageGraph(snapshot);
      const count = degrees(structure, id);
      const incoming = snapshot.edges.filter((edge) => edge.to === id);
      const outgoing = snapshot.edges.filter((edge) => edge.from === id);
      return {
        ...summarizeNode(snapshot, node),
        measures: node.measures ?? [],
        inDegree: count.inDegree,
        outDegree: count.outDegree,
        standsOn: incoming.map((edge) => ({
          id: edge.from,
          relation: relationOf(structure, edge.from, id) ?? edge.relation,
        })),
        before: outgoing.map((edge) => ({
          id: edge.to,
          relation: relationOf(structure, id, edge.to) ?? edge.relation,
        })),
      };
    },
  };

  return [map, impact, upstreamOf, loops, schedule, stats, deeper, route, part].map((tool) =>
    Object.freeze({...tool, call: tool.call.bind(tool)}),
  );
}

/**
 * Finds and invokes a tool by name.
 *
 * @throws {AtlasMcpInputError} If no tool has the given name or the input is invalid.
 */
export async function callAtlasTool(
  tools: readonly AtlasMcpTool[],
  name: string,
  input?: unknown,
): Promise<Record<string, unknown>> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new AtlasMcpInputError(`Unknown atlas tool "${name}".`);
  return await tool.call(input);
}

/**
 * Converts atlas tools to MCP tool definitions.
 */
export function toMcpTools(tools: readonly AtlasMcpTool[]): McpToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: MCP_ANNOTATIONS,
  }));
}

/**
 * Handles MCP `tools/call` parameters.
 *
 * Input and scan errors become tool results with `isError: true`, as the MCP
 * specification requires, so a model can read and correct them.
 */
export async function callMcpTool(
  tools: readonly AtlasMcpTool[],
  params: {readonly name: string; readonly arguments?: Record<string, unknown> | undefined},
): Promise<McpToolResult> {
  try {
    const structuredContent = await callAtlasTool(tools, params.name, params.arguments);
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

/**
 * Speaks MCP JSON-RPC on stdio.
 *
 * Does not read `process.argv`. The caller owns the default root. `close`
 * detaches the streams and does not exit the process.
 */
export function startAtlasMcpServer(
  options: {
    readonly root?: string;
    readonly input?: Readable;
    readonly output?: Writable;
    readonly tools?: readonly AtlasMcpTool[];
  } = {},
): AtlasMcpConnection {
  const tools =
    options.tools ?? createAtlasMcpTools(options.root === undefined ? {} : {root: options.root});
  return connectAtlasMcp(tools, options);
}

/**
 * JSON-RPC 2.0 MCP transport over newline-delimited messages.
 */
export function connectAtlasMcp(
  tools: readonly AtlasMcpTool[],
  options: {
    readonly input?: Readable;
    readonly output?: Writable;
  } = {},
): AtlasMcpConnection {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const version = packageVersion();
  const listed = toMcpTools(tools);
  let buffer = '';
  let protocol = DEFAULT_PROTOCOL;
  let ready = false;
  let closed = false;

  const write = (message: object): void => {
    if (closed) return;
    output.write(`${JSON.stringify(message)}\n`);
  };

  const reply = (id: JsonRpcId, result: unknown): void => {
    write({jsonrpc: '2.0', id, result});
  };

  const fail = (id: JsonRpcId, code: number, message: string): void => {
    write({jsonrpc: '2.0', id, error: {code, message}});
  };

  const handle = async (message: JsonRpcRequest): Promise<void> => {
    const id = message.id;
    const method = typeof message.method === 'string' ? message.method : '';

    if (message.jsonrpc !== '2.0' || method.length === 0) {
      if (id !== undefined) fail(id, -32600, 'Invalid Request');
      return;
    }

    if (method === 'notifications/initialized' || method === 'initialized') {
      ready = true;
      return;
    }

    if (id === undefined) return;

    if (method === 'initialize') {
      const params = isRecord(message.params) ? message.params : {};
      const requested = params['protocolVersion'];
      protocol =
        typeof requested === 'string' &&
        (PROTOCOL_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : DEFAULT_PROTOCOL;
      ready = true;
      reply(id, {
        protocolVersion: protocol,
        capabilities: {tools: {}},
        serverInfo: {name: SERVER_NAME, version},
        instructions:
          'grafyx/atlas maps software structure. Call atlas_map first, then atlas_impact, atlas_upstream, atlas_cycles, atlas_order, atlas_stats, atlas_focus, atlas_path, or atlas_part. Pass root to scan another directory. Part ids can be unique prefixes.',
      });
      return;
    }

    if (method === 'ping') {
      reply(id, {});
      return;
    }

    if (!ready) {
      fail(id, -32600, 'Server not initialized');
      return;
    }

    if (method === 'tools/list') {
      reply(id, {tools: listed});
      return;
    }

    if (method === 'tools/call') {
      const params = isRecord(message.params) ? message.params : {};
      const name = params['name'];
      if (typeof name !== 'string' || name.length === 0) {
        fail(id, -32602, 'Invalid params');
        return;
      }
      const args = params['arguments'];
      const result = await callMcpTool(tools, isRecord(args) ? {name, arguments: args} : {name});
      reply(id, result);
      return;
    }

    fail(id, -32601, `Method not found: ${method}`);
  };

  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        fail(null, -32700, 'Parse error');
        continue;
      }

      if (Array.isArray(parsed)) {
        fail(null, -32600, 'Invalid Request');
        continue;
      }

      void handle(parsed as JsonRpcRequest).catch((error: unknown) => {
        const requestId = isRecord(parsed) && 'id' in parsed ? (parsed['id'] as JsonRpcId) : null;
        fail(requestId, -32603, error instanceof Error ? error.message : String(error));
      });
    }
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    input.off('data', onData);
    input.off('end', close);
  };

  input.on('data', onData);
  input.on('end', close);
  if (typeof input.resume === 'function') input.resume();

  return {close};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
