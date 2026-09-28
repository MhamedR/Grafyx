/**
 * One reactive session for one workspace root.
 *
 * React reads the computed picture. It does not own the graph.
 */

import {ReactiveComputed, ReactiveRuntime, ReactiveValue} from 'grafyx';
import {
  createExternalStore,
  createMicrotaskScheduler,
  type ReactiveExternalStore,
} from 'grafyx/store';
import type {AtlasSnapshot, Lens, Viewport} from './model.js';
import {isLens} from './model.js';
import type {AtlasLayout, NodeOffset} from './layout.js';
import {applyOffsets, layoutSnapshot} from './layout.js';
import {
  buildPackageGraph,
  components,
  cycles,
  downstream,
  order,
  upstream,
  type BuildOrder,
  type PackageGraph,
} from './structural.js';

export interface Emphasis {
  readonly nodes: readonly string[];
  readonly edges: readonly string[];
}

export interface AtlasSession {
  readonly runtime: ReactiveRuntime;
  readonly root: ReactiveValue<string>;
  readonly snapshot: ReactiveValue<AtlasSnapshot | null>;
  readonly selectedId: ReactiveValue<string | null>;
  readonly hoveredId: ReactiveValue<string | null>;
  readonly lens: ReactiveValue<Lens>;
  readonly query: ReactiveValue<string>;
  readonly reducedMotion: ReactiveValue<boolean>;
  readonly viewport: ReactiveValue<Viewport>;
  readonly offsets: ReactiveValue<Readonly<Record<string, NodeOffset>>>;
  readonly draggingId: ReactiveValue<string | null>;
  readonly crumbs: ReactiveValue<readonly string[]>;
  readonly graph: ReactiveComputed<PackageGraph | null>;
  readonly downstream: ReactiveComputed<readonly string[]>;
  readonly upstream: ReactiveComputed<readonly string[]>;
  readonly order: ReactiveComputed<BuildOrder>;
  readonly components: ReactiveComputed<readonly (readonly string[])[]>;
  readonly emphasis: ReactiveComputed<Emphasis>;
  readonly layout: ReactiveComputed<AtlasLayout | null>;
  replaceSnapshot(snapshot: AtlasSnapshot): void;
  select(id: string | null): void;
  setLens(lens: Lens): void;
  setQuery(query: string): void;
  setViewport(viewport: Viewport): void;
  setReducedMotion(reduced: boolean): void;
  setHovered(id: string | null): void;
  setDragging(id: string | null): void;
  moveNode(id: string, dx: number, dy: number): void;
  pushDepth(snapshot: AtlasSnapshot, label: string): void;
  ascend(index: number): void;
  moveSelection(direction: 'outgoing' | 'incoming'): void;
  command(input: string): void;
  dispose(): void;
}

export interface AtlasConnection {
  readonly root: ReactiveExternalStore<string>;
  readonly snapshot: ReactiveExternalStore<AtlasSnapshot | null>;
  readonly selectedId: ReactiveExternalStore<string | null>;
  readonly lens: ReactiveExternalStore<Lens>;
  readonly query: ReactiveExternalStore<string>;
  readonly reducedMotion: ReactiveExternalStore<boolean>;
  readonly hoveredId: ReactiveExternalStore<string | null>;
  readonly draggingId: ReactiveExternalStore<string | null>;
  readonly crumbs: ReactiveExternalStore<readonly string[]>;
  readonly order: ReactiveExternalStore<BuildOrder>;
  readonly emphasis: ReactiveExternalStore<Emphasis>;
  readonly layout: ReactiveExternalStore<AtlasLayout | null>;
  dispose(): void;
}

const EMPTY_EMPHASIS: Emphasis = {nodes: [], edges: []};
const EMPTY_ORDER: BuildOrder = {kind: 'order', ids: []};

export function createAtlasSession(options: {
  readonly root: string;
  readonly snapshot?: AtlasSnapshot | null;
  readonly reducedMotion?: boolean;
  readonly viewport?: Viewport;
}): AtlasSession {
  const runtime = new ReactiveRuntime();
  const root = new ReactiveValue(runtime, 'atlas:root', options.root);
  const snapshot = new ReactiveValue<AtlasSnapshot | null>(
    runtime,
    'atlas:snapshot',
    options.snapshot ?? null,
  );
  const selectedId = new ReactiveValue<string | null>(runtime, 'atlas:selected', null);
  const hoveredId = new ReactiveValue<string | null>(runtime, 'atlas:hovered', null);
  const lens = new ReactiveValue<Lens>(runtime, 'atlas:lens', 'map');
  const query = new ReactiveValue(runtime, 'atlas:query', '');
  const reducedMotion = new ReactiveValue(runtime, 'atlas:motion', options.reducedMotion ?? false);
  const viewport = new ReactiveValue<Viewport>(
    runtime,
    'atlas:viewport',
    options.viewport ?? {width: 0, height: 0},
  );
  const offsets = new ReactiveValue<Readonly<Record<string, NodeOffset>>>(
    runtime,
    'atlas:offsets',
    {},
  );
  const draggingId = new ReactiveValue<string | null>(runtime, 'atlas:dragging', null);
  const crumbs = new ReactiveValue<readonly string[]>(runtime, 'atlas:crumbs', []);
  const history: AtlasSnapshot[] = [];

  const graph = new ReactiveComputed(runtime, 'atlas:graph', () => {
    const current = snapshot.value;
    if (!current) return null;
    return buildPackageGraph(current);
  });

  const downstreamOf = new ReactiveComputed(runtime, 'atlas:downstream', () => {
    const structure = graph.value;
    const selected = selectedId.value;
    if (!structure || !selected) return [];
    return downstream(structure, selected);
  });

  const upstreamOf = new ReactiveComputed(runtime, 'atlas:upstream', () => {
    const structure = graph.value;
    const selected = selectedId.value;
    if (!structure || !selected) return [];
    return upstream(structure, selected);
  });

  const buildOrder = new ReactiveComputed(runtime, 'atlas:order', () => {
    const structure = graph.value;
    if (!structure) return EMPTY_ORDER;
    return order(structure);
  });

  const componentList = new ReactiveComputed(runtime, 'atlas:components', () => {
    const structure = graph.value;
    if (!structure) return [];
    return components(structure);
  });

  const emphasis = new ReactiveComputed(runtime, 'atlas:emphasis', () => {
    const current = snapshot.value;
    const structure = graph.value;
    const active = lens.value;
    if (!current || !structure) return EMPTY_EMPHASIS;

    if (active === 'map') {
      return {
        nodes: current.nodes.map((node) => node.id),
        edges: current.edges.map((edge) => edge.id),
      };
    }

    if (active === 'order') {
      return {nodes: current.nodes.map((node) => node.id), edges: []};
    }

    if (active === 'cycles') {
      const cyclic = new Set(cycles(structure).flat());
      return {
        nodes: [...cyclic],
        edges: current.edges
          .filter((edge) => cyclic.has(edge.from) && cyclic.has(edge.to))
          .map((edge) => edge.id),
      };
    }

    const selected = selectedId.value;
    if (!selected) return EMPTY_EMPHASIS;

    if (active === 'impact') {
      const next = downstreamOf.value;
      const cone = new Set([selected, ...next]);
      const targets = new Set(next);
      return {
        nodes: [...cone],
        edges: current.edges
          .filter((edge) => cone.has(edge.from) && targets.has(edge.to))
          .map((edge) => edge.id),
      };
    }

    const previous = upstreamOf.value;
    const cone = new Set([selected, ...previous]);
    const sources = new Set(previous);
    return {
      nodes: [...cone],
      edges: current.edges
        .filter((edge) => sources.has(edge.from) && cone.has(edge.to))
        .map((edge) => edge.id),
    };
  });

  const placed = new ReactiveComputed(runtime, 'atlas:placed', () => {
    const current = snapshot.value;
    const size = viewport.value;
    if (!current) return null;
    return layoutSnapshot(current, size);
  });

  const layout = new ReactiveComputed(runtime, 'atlas:layout', () => {
    const base = placed.value;
    if (!base) return null;
    return applyOffsets(base, offsets.value);
  });

  const neighborCursor = new Map<string, number>();

  const session: AtlasSession = {
    runtime,
    root,
    snapshot,
    selectedId,
    hoveredId,
    lens,
    query,
    reducedMotion,
    viewport,
    offsets,
    draggingId,
    crumbs,
    graph,
    downstream: downstreamOf,
    upstream: upstreamOf,
    order: buildOrder,
    components: componentList,
    emphasis,
    layout,
    replaceSnapshot(next) {
      runtime.batch(() => {
        snapshot.value = next;
        if (selectedId.value && !next.nodes.some((node) => node.id === selectedId.value)) {
          selectedId.value = null;
        }
        const kept: Record<string, NodeOffset> = {};
        for (const node of next.nodes) {
          const offset = offsets.value[node.id];
          if (offset) kept[node.id] = offset;
        }
        offsets.value = kept;
        if (draggingId.value && !next.nodes.some((node) => node.id === draggingId.value)) {
          draggingId.value = null;
        }
      });
    },
    select(id) {
      runtime.batch(() => {
        selectedId.value = id;
      });
    },
    setLens(next) {
      runtime.batch(() => {
        lens.value = next;
      });
    },
    setQuery(next) {
      runtime.batch(() => {
        query.value = next;
      });
    },
    setViewport(next) {
      const current = viewport.value;
      if (current.width === next.width && current.height === next.height) return;
      runtime.batch(() => {
        viewport.value = next;
      });
    },
    setReducedMotion(reduced) {
      runtime.batch(() => {
        reducedMotion.value = reduced;
      });
    },
    setHovered(id) {
      if (hoveredId.value === id) return;
      runtime.batch(() => {
        hoveredId.value = id;
      });
    },
    setDragging(id) {
      if (draggingId.value === id) return;
      runtime.batch(() => {
        draggingId.value = id;
      });
    },
    moveNode(id, dx, dy) {
      if (dx === 0 && dy === 0) return;
      if (!snapshot.value?.nodes.some((node) => node.id === id)) return;
      runtime.batch(() => {
        const current = offsets.value[id] ?? {x: 0, y: 0};
        offsets.value = {
          ...offsets.value,
          [id]: {x: current.x + dx, y: current.y + dy},
        };
      });
    },
    pushDepth(next, label) {
      const current = snapshot.value;
      if (!current) return;
      runtime.batch(() => {
        history.push(current);
        crumbs.value = [...crumbs.value, label];
        snapshot.value = next;
        selectedId.value = null;
        hoveredId.value = null;
        offsets.value = {};
        draggingId.value = null;
      });
    },
    ascend(index) {
      if (index < 0 || index >= history.length) return;
      const restored = history[index];
      if (!restored) return;
      runtime.batch(() => {
        history.splice(index);
        crumbs.value = crumbs.value.slice(0, index);
        snapshot.value = restored;
        selectedId.value = null;
        hoveredId.value = null;
        offsets.value = {};
        draggingId.value = null;
      });
    },
    moveSelection(direction) {
      const structure = graph.value;
      if (!structure) return;

      const selected = selectedId.value;
      if (!selected || !structure.graph.hasNode(selected)) {
        const first =
          buildOrder.value.kind === 'order'
            ? buildOrder.value.ids[0]
            : structure.graph.getNodes()[0]?.id;
        if (first) session.select(first);
        return;
      }

      const neighbors = (
        direction === 'outgoing'
          ? structure.graph.getOutgoing(selected)
          : structure.graph.getIncoming(selected)
      )
        .map((node) => node.id)
        .sort();

      const next = neighbors[0];
      if (next === undefined) return;

      const key = `${selected}:${direction}`;
      const index = neighborCursor.get(key) ?? 0;
      neighborCursor.set(key, index + 1);
      const chosen = neighbors[index % neighbors.length] ?? next;
      session.select(chosen);
    },
    command(input) {
      const names = snapshot.value?.nodes.map((node) => node.id) ?? [];
      const parsed = parseCommand(input, names);
      runtime.batch(() => {
        if (parsed.packageId) selectedId.value = parsed.packageId;
        if (parsed.lens) lens.value = parsed.lens;
      });
    },
    dispose() {
      runtime.dispose();
    },
  };

  return session;
}

export function connectAtlasSession(session: AtlasSession): AtlasConnection {
  const scheduler = createMicrotaskScheduler();
  const stores = {
    root: createExternalStore(session.runtime, session.root, {scheduler, id: 'atlas:store:root'}),
    snapshot: createExternalStore(session.runtime, session.snapshot, {
      scheduler,
      id: 'atlas:store:snapshot',
    }),
    selectedId: createExternalStore(session.runtime, session.selectedId, {
      scheduler,
      id: 'atlas:store:selected',
    }),
    lens: createExternalStore(session.runtime, session.lens, {scheduler, id: 'atlas:store:lens'}),
    query: createExternalStore(session.runtime, session.query, {
      scheduler,
      id: 'atlas:store:query',
    }),
    reducedMotion: createExternalStore(session.runtime, session.reducedMotion, {
      scheduler,
      id: 'atlas:store:motion',
    }),
    hoveredId: createExternalStore(session.runtime, session.hoveredId, {
      scheduler,
      id: 'atlas:store:hovered',
    }),
    draggingId: createExternalStore(session.runtime, session.draggingId, {
      scheduler,
      id: 'atlas:store:dragging',
    }),
    crumbs: createExternalStore(session.runtime, session.crumbs, {
      scheduler,
      id: 'atlas:store:crumbs',
    }),
    order: createExternalStore(session.runtime, session.order, {
      scheduler,
      id: 'atlas:store:order',
    }),
    emphasis: createExternalStore(session.runtime, session.emphasis, {
      scheduler,
      id: 'atlas:store:emphasis',
    }),
    layout: createExternalStore(session.runtime, session.layout, {
      scheduler,
      id: 'atlas:store:layout',
    }),
  };

  return {
    ...stores,
    dispose() {
      stores.root.dispose();
      stores.snapshot.dispose();
      stores.selectedId.dispose();
      stores.lens.dispose();
      stores.query.dispose();
      stores.reducedMotion.dispose();
      stores.hoveredId.dispose();
      stores.draggingId.dispose();
      stores.crumbs.dispose();
      stores.order.dispose();
      stores.emphasis.dispose();
      stores.layout.dispose();
    },
  };
}

export function parseCommand(
  input: string,
  packageIds: readonly string[],
): {readonly packageId: string | null; readonly lens: Lens | null} {
  const tokens = input
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  let packageId: string | null = null;
  let lens: Lens | null = null;

  for (const token of tokens) {
    const lowered = token.toLowerCase();
    if (isLens(lowered)) {
      lens = lowered;
      continue;
    }

    const exact = packageIds.find((id) => id === token || id.toLowerCase() === lowered);
    if (exact) {
      packageId = exact;
      continue;
    }

    const partial = packageIds.filter((id) => id.toLowerCase().includes(lowered));
    if (partial.length === 1 && partial[0]) packageId = partial[0];
  }

  return {packageId, lens};
}

/** The `?lens=&id=` query the editor uses to open the map on a chosen part. */
export function viewFromSearch(search: string): {
  readonly packageId: string | null;
  readonly lens: Lens | null;
  readonly stats: boolean;
} {
  const params = new URLSearchParams(search);
  const lensToken = params.get('lens')?.toLowerCase() ?? '';
  const id = params.get('id')?.trim() ?? '';
  return {
    packageId: id.length > 0 ? id : null,
    lens: isLens(lensToken) ? lensToken : null,
    stats: lensToken === 'stats',
  };
}
