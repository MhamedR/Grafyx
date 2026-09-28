/**
 * The map. React renders the reactive session; it does not keep a second graph.
 */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {createRoot} from 'react-dom/client';
import type {ReactiveExternalStore} from 'grafyx/store';
import {
  CYCLE_CLEAR,
  DIRECTION_LINE,
  EMPTY_LINE,
  LENSES,
  LENS_QUESTION,
  SOURCE_LENS_QUESTION,
  READING_LINE,
  formatBytes,
  nodeCaption,
  nodeShape,
  type AtlasBoot,
  type AtlasSnapshot,
  type PackageNode,
} from '../model.js';
import type {AtlasLayout, PlacedEdge, PlacedNode} from '../layout.js';
import {
  connectAtlasSession,
  createAtlasSession,
  type AtlasConnection,
  type AtlasSession,
  type Emphasis,
} from '../session.js';
import {buildExportPicture, exportFilename} from '../export.js';
import {connectionCurve} from './curves.js';
import {savePicture} from './paint.js';
import {StatsBoard} from './stats.js';

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

function readBoot(): AtlasBoot {
  const element = document.getElementById('atlas-boot');
  if (!element?.textContent) {
    return {root: '', snapshot: null, error: 'Missing atlas boot data.'};
  }

  return JSON.parse(element.textContent) as AtlasBoot;
}

function useStore<T>(store: ReactiveExternalStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

function AtlasApp({boot}: {readonly boot: AtlasBoot}) {
  const session = useRef<AtlasSession | null>(null);
  const connection = useRef<AtlasConnection | null>(null);

  if (session.current === null || connection.current === null) {
    const created = createAtlasSession({
      root: boot.root,
      snapshot: boot.snapshot,
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    });
    session.current = created;
    connection.current = connectAtlasSession(created);
  }

  useEffect(() => {
    const current = session.current;
    const stores = connection.current;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = (): void => {
      current?.setReducedMotion(media.matches);
    };

    media.addEventListener('change', apply);

    return () => {
      media.removeEventListener('change', apply);
      stores?.dispose();
      current?.dispose();
    };
  }, [boot.root]);

  const stores = connection.current;
  const picture = session.current;

  return <Picture boot={boot} session={picture} stores={stores} />;
}

function Picture({
  boot,
  session,
  stores,
}: {
  readonly boot: AtlasBoot;
  readonly session: AtlasSession;
  readonly stores: AtlasConnection;
}) {
  const snapshot = useStore(stores.snapshot);
  const selectedId = useStore(stores.selectedId);
  const hoveredId = useStore(stores.hoveredId);
  const draggingId = useStore(stores.draggingId);
  const lens = useStore(stores.lens);
  const query = useStore(stores.query);
  const reducedMotion = useStore(stores.reducedMotion);
  const emphasis = useStore(stores.emphasis);
  const layout = useStore(stores.layout);
  const stageRef = useRef<HTMLElement | null>(null);
  const [command, setCommand] = useState('');
  const [menu, setMenu] = useState<{id: string; x: number; y: number} | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [board, setBoard] = useState<'map' | 'stats'>('map');
  const crumbs = useStore(stores.crumbs);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const measure = (): void => {
      const width = Math.round(stage.clientWidth);
      const height = Math.round(stage.clientHeight);
      if (width < 40 || height < 40) return;
      session.setViewport({width, height});
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [session]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
      if (event.key === 'Escape') {
        if (exportOpen) {
          setExportOpen(false);
          return;
        }
        if (menu) {
          setMenu(null);
          return;
        }
        session.runtime.batch(() => {
          session.query.value = '';
          session.selectedId.value = null;
        });
        setCommand('');
        return;
      }

      if (typing) return;

      if (
        event.key === 'ArrowRight' ||
        event.key === 'ArrowDown' ||
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowUp'
      ) {
        event.preventDefault();
        session.moveSelection(event.shiftKey ? 'incoming' : 'outgoing');
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'Backspace') {
        event.preventDefault();
        session.setQuery(session.query.value.slice(0, -1));
        return;
      }

      if (event.key.length === 1) {
        session.setQuery(session.query.value + event.key);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exportOpen, menu, session]);

  const buildOrder = useStore(stores.order);
  const selected = snapshot?.nodes.find((node) => node.id === selectedId) ?? null;
  const hovered = snapshot?.nodes.find((node) => node.id === hoveredId) ?? null;
  const hoveredPlace = layout?.nodes.find((node) => node.id === hoveredId) ?? null;
  const acyclic = buildOrder.kind === 'order';
  const questions = snapshot?.kind === 'source' ? SOURCE_LENS_QUESTION : LENS_QUESTION;
  const question =
    board === 'stats'
      ? 'Where the weight sits, and how far a change reaches.'
      : lens === 'cycles' && acyclic
        ? CYCLE_CLEAR
        : questions[lens];
  const filter = query.trim().toLowerCase();

  return (
    <div className="app" data-reduced={reducedMotion ? 'true' : 'false'}>
      <header className="header">
        <div className="header-top">
          <div className="brand">
            <h1 className="wordmark">
              grafyx<span className="slash">/</span>atlas
            </h1>
            <p className="root-path">{boot.root}</p>
          </div>
          <div className="export">
            <button
              type="button"
              data-export
              data-open={exportOpen ? 'true' : 'false'}
              aria-haspopup="menu"
              aria-expanded={exportOpen}
              disabled={!layout || layout.nodes.length === 0}
              onClick={(event) => {
                event.stopPropagation();
                setMenu(null);
                setExportOpen((open) => !open);
              }}
            >
              export
            </button>
            {exportError ? <p className="export-note">{exportError}</p> : null}
            {exportOpen && snapshot && layout ? (
              <div className="menu" role="menu" data-export-menu>
                {(
                  [
                    ['drawio', 'Draw.io'],
                    ['pdf', 'PDF'],
                    ['jpeg', 'JPEG'],
                  ] as const
                ).map(([kind, label]) => (
                  <button
                    key={kind}
                    type="button"
                    role="menuitem"
                    onClick={(event) => {
                      event.stopPropagation();
                      const extension = kind === 'drawio' ? 'drawio' : kind;
                      const picture = buildExportPicture({
                        root: snapshot.root,
                        lens,
                        snapshot,
                        layout,
                        emphasis,
                        selectedId,
                        filter,
                      });
                      setExportOpen(false);
                      setExportError(null);
                      void savePicture(
                        kind,
                        picture,
                        exportFilename(snapshot.root, lens, extension),
                      ).catch((error: unknown) => {
                        setExportError(
                          error instanceof Error ? error.message : 'Could not export the picture.',
                        );
                      });
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <p className="direction">{DIRECTION_LINE}</p>
        {crumbs.length > 0 ? (
          <nav className="crumbs" aria-label="Depth">
            <button type="button" onClick={() => session.ascend(0)}>
              {boot.root.split('/').pop()}
            </button>
            {crumbs.map((crumb, index) => (
              <span key={`${crumb}:${index}`}>
                <span className="crumb-sep">/</span>
                {index === crumbs.length - 1 ? (
                  <span className="crumb-current">{crumb}</span>
                ) : (
                  <button type="button" onClick={() => session.ascend(index + 1)}>
                    {crumb}
                  </button>
                )}
              </span>
            ))}
          </nav>
        ) : null}
      </header>
      <aside className="rail">
        <div>
          <nav className="lenses" aria-label="Lenses">
            {LENSES.map((item) => (
              <button
                key={item}
                type="button"
                data-lens={item}
                data-active={board === 'map' && item === lens ? 'true' : 'false'}
                onClick={() => {
                  setBoard('map');
                  session.setLens(item);
                }}
              >
                {item}
              </button>
            ))}
            <button
              type="button"
              data-lens="stats"
              data-active={board === 'stats' ? 'true' : 'false'}
              onClick={() => {
                session.setHovered(null);
                setBoard('stats');
              }}
            >
              stats
            </button>
          </nav>
          <p className="question" data-question>
            {question}
          </p>
          {filter.length > 0 ? (
            <p className="filter-note" data-query>
              {query}
            </p>
          ) : null}
        </div>
        {selected && snapshot ? <Inspector snapshot={snapshot} node={selected} /> : null}
      </aside>
      <main
        className="stage"
        ref={stageRef}
        onClick={() => {
          setMenu(null);
          setExportOpen(false);
          session.select(null);
        }}
      >
        {boot.error ? (
          <div className="field-message" data-state="error">
            <p>{boot.error}</p>
            <p>{boot.root}</p>
          </div>
        ) : snapshot === null ? (
          <div className="field-message" data-state="loading">
            <p>{READING_LINE}</p>
          </div>
        ) : snapshot.nodes.length === 0 ? (
          <div className="field-message" data-state="empty">
            <p>{EMPTY_LINE}</p>
          </div>
        ) : board === 'stats' && snapshot ? (
          <StatsBoard snapshot={snapshot} onSelect={(id) => session.select(id)} />
        ) : layout && layout.nodes.length > 0 ? (
          <Fitted layout={layout} scale={pictureScale(layout)}>
            <Graph
              snapshot={snapshot}
              layoutNodes={layout.nodes}
              layoutEdges={layout.edges}
              ranks={layout.ranks}
              width={layout.width}
              height={layout.height}
              scale={pictureScale(layout)}
              emphasis={emphasis}
              selectedId={selectedId}
              hoveredId={hoveredId}
              draggingId={draggingId}
              filter={filter}
              reducedMotion={reducedMotion}
              onHover={(id) => session.setHovered(id)}
              onSelect={(id) => session.select(id)}
              onDragStart={(id) => session.setDragging(id)}
              onDragEnd={() => session.setDragging(null)}
              onMove={(id, dx, dy) => session.moveNode(id, dx, dy)}
              onMenu={(id, x, y) => {
                session.setHovered(null);
                setExportOpen(false);
                setMenu({id, x, y});
              }}
            />
          </Fitted>
        ) : null}
        {board === 'map' && hovered && snapshot && draggingId === null && menu === null ? (
          <PackageTooltip
            snapshot={snapshot}
            node={hovered}
            rank={hoveredPlace?.rank ?? null}
            x={hoveredPlace?.x ?? 0}
            y={hoveredPlace?.y ?? 0}
          />
        ) : null}
      </main>
      <footer className="footer">
        <ol className="filmstrip">
          {layout?.ranks.map((rank) => (
            <li key={rank.index} data-rank={rank.index}>
              <span className="rank-index">{rank.index}</span>
              {rank.ids.map((id) => (
                <button
                  key={id}
                  type="button"
                  data-selected={id === selectedId ? 'true' : 'false'}
                  onClick={() => session.select(id)}
                >
                  {id}
                </button>
              ))}
            </li>
          ))}
        </ol>
        <form
          className="command"
          onSubmit={(event) => {
            event.preventDefault();
            session.command(command);
            setCommand('');
          }}
        >
          <span>Command</span>
          <input
            aria-label="Command"
            placeholder="package lens"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
          />
        </form>
      </footer>
      {menu && snapshot ? (
        <div className="menu" role="menu" style={{left: menu.x, top: menu.y}} data-menu>
          <button
            type="button"
            role="menuitem"
            onClick={(event) => {
              event.stopPropagation();
              const node = snapshot.nodes.find((item) => item.id === menu.id);
              setMenu(null);
              if (!node) return;
              void openDeeper(session, snapshot.root, node);
            }}
          >
            Go deeper
          </button>
        </div>
      ) : null}
    </div>
  );
}

async function openDeeper(session: AtlasSession, root: string, node: PackageNode): Promise<void> {
  const response = await fetch(`/api/focus?path=${encodeURIComponent(node.path)}`);
  if (!response.ok) return;
  const next = (await response.json()) as AtlasSnapshot;
  if (next.root !== root || next.nodes.length === 0) return;
  session.pushDepth(next, node.id);
}

function pictureScale(layout: AtlasLayout): number {
  if (layout.width <= 0 || layout.height <= 0) return 1;
  return Math.min(1, layout.frameWidth / layout.width, layout.frameHeight / layout.height);
}

function Fitted({
  layout,
  scale,
  children,
}: {
  readonly layout: AtlasLayout;
  readonly scale: number;
  readonly children: ReactNode;
}) {
  const fit = scale;

  return (
    <div className="fit" style={{width: layout.frameWidth, height: layout.frameHeight}}>
      <div
        className="fit-scale"
        style={{
          width: layout.width * fit,
          height: layout.height * fit,
          marginTop: Math.max(0, (layout.frameHeight - layout.height * fit) / 2),
        }}
      >
        <div
          style={{
            width: layout.width,
            height: layout.height,
            transform: `scale(${fit})`,
            transformOrigin: 'top left',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function Inspector({
  snapshot,
  node,
}: {
  readonly snapshot: AtlasSnapshot;
  readonly node: PackageNode;
}) {
  const incoming = new Set(
    snapshot.edges.filter((edge) => edge.to === node.id).map((edge) => edge.from),
  );
  const outgoing = new Set(
    snapshot.edges.filter((edge) => edge.from === node.id).map((edge) => edge.to),
  );
  const relations = snapshot.edges.filter((edge) => edge.from === node.id || edge.to === node.id);
  const shape = nodeShape(snapshot.kind, node);

  return (
    <section className="inspector" data-inspector>
      <p className="inspector-name">{node.id}</p>
      {shape ? <p className="inspector-kind">{shape}</p> : null}
      {node.description.length > 0 ? <p>{node.description}</p> : null}
      <p>{node.path}</p>
      {shape === 'folder' && node.files && node.files.length > 0 ? (
        <div className="split">
          <p className="split-label">Files</p>
          <ul>
            {node.files.map((file) => {
              const measure = node.measures?.find((item) => item.path === file);
              return (
                <li key={file}>
                  {file}
                  {measure ? ` · ${formatBytes(measure.bytes)}` : ''}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      <div className="split">
        <p className="split-label">
          {incoming.size} in · {outgoing.size} out
        </p>
        <ul>
          {relations.map((edge) => (
            <li key={edge.id}>
              {edge.from} → {edge.to} {edge.relation}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function PackageTooltip({
  snapshot,
  node,
  rank,
  x,
  y,
}: {
  readonly snapshot: AtlasSnapshot;
  readonly node: PackageNode;
  readonly rank: number | null;
  readonly x: number;
  readonly y: number;
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{left: number; top: number; place: 'above' | 'below'} | null>(
    null,
  );

  useLayoutEffect(() => {
    const source = document.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`);
    const tip = anchorRef.current;
    if (!(source instanceof HTMLElement) || !tip) return;

    const sourceBox = source.getBoundingClientRect();
    const tipBox = tip.getBoundingClientRect();
    const above = sourceBox.top - tipBox.height - 10;
    const place = above < 12 ? 'below' : 'above';
    const top = place === 'above' ? above : sourceBox.bottom + 10;
    const left = Math.min(Math.max(12, sourceBox.left), window.innerWidth - tipBox.width - 12);
    setBox({left, top, place});
  }, [node.id, rank, x, y]);

  const incoming = snapshot.edges.filter((edge) => edge.to === node.id);
  const outgoing = snapshot.edges.filter((edge) => edge.from === node.id);
  const files = node.files ?? [];
  const shape = nodeShape(snapshot.kind, node);
  const description = node.description.length > 0 ? node.description : null;

  return (
    <div
      ref={anchorRef}
      className="tooltip"
      role="tooltip"
      id="atlas-tooltip"
      data-tooltip={node.id}
      data-place={box?.place ?? 'below'}
      style={{
        left: box?.left ?? -9999,
        top: box?.top ?? 0,
        visibility: box ? 'visible' : 'hidden',
      }}
    >
      <p className="tooltip-name">{node.id}</p>
      <p className="tooltip-meta">
        {nodeCaption(node, shape)}
        {rank === null ? '' : ` · rank ${rank}`}
        {shape === null ? (node.private ? ' · private' : ' · published') : ''}
      </p>
      {description ? <p>{description}</p> : null}
      <p className="tooltip-path">{node.path}</p>
      {shape === 'folder' && files.length > 0 ? (
        <div className="split">
          <p className="split-label">Files</p>
          <ul className="tooltip-files">
            {files.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="split">
        <p className="split-label">
          {incoming.length} in · {outgoing.length} out
        </p>
        {incoming.length > 0 ? (
          <ul>
            {incoming.map((edge) => (
              <li key={edge.id}>
                <span className="tooltip-role">stands on</span> {edge.from}
                <span className="tooltip-relation">{edge.relation}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {outgoing.length > 0 ? (
          <ul>
            {outgoing.map((edge) => (
              <li key={edge.id}>
                <span className="tooltip-role">before</span> {edge.to}
                <span className="tooltip-relation">{edge.relation}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function Graph({
  snapshot,
  layoutNodes,
  layoutEdges,
  ranks,
  width,
  height,
  scale,
  emphasis,
  selectedId,
  hoveredId,
  draggingId,
  filter,
  reducedMotion,
  onHover,
  onSelect,
  onDragStart,
  onDragEnd,
  onMove,
  onMenu,
}: {
  readonly snapshot: AtlasSnapshot;
  readonly layoutNodes: readonly PlacedNode[];
  readonly layoutEdges: readonly PlacedEdge[];
  readonly ranks: readonly {readonly index: number; readonly x: number; readonly width: number}[];
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly emphasis: Emphasis;
  readonly selectedId: string | null;
  readonly hoveredId: string | null;
  readonly draggingId: string | null;
  readonly filter: string;
  readonly reducedMotion: boolean;
  readonly onHover: (id: string | null) => void;
  readonly onSelect: (id: string) => void;
  readonly onDragStart: (id: string) => void;
  readonly onDragEnd: () => void;
  readonly onMove: (id: string, dx: number, dy: number) => void;
  readonly onMenu: (id: string, x: number, y: number) => void;
}) {
  const packages = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const emphasizedNodes = new Set(emphasis.nodes);
  const emphasizedEdges = new Set(emphasis.edges);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const edgeRefs = useRef(new Map<string, SVGPathElement>());
  const dragRef = useRef<{
    id: string;
    x: number;
    y: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const positions = useRef(new Map<string, {x: number; y: number; scale: number}>());
  const edgePaths = useRef(new Map<string, string>());
  const seenEmphasis = useRef<string | null>(null);
  const animations = useRef<Animation[]>([]);

  const curves = useMemo(() => {
    const byId = new Map(layoutNodes.map((node) => [node.id, node]));
    const drawn = new Map<string, string>();

    for (const edge of layoutEdges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) continue;
      const bend =
        edge.relation === 'bundle-includes' &&
        layoutEdges.some(
          (other) =>
            other.id !== edge.id &&
            other.from === edge.from &&
            other.to === edge.to &&
            other.relation !== edge.relation,
        )
          ? 8
          : 0;
      drawn.set(edge.id, connectionCurve(from, to, bend));
    }

    return drawn;
  }, [layoutEdges, layoutNodes]);

  useLayoutEffect(() => {
    for (const animation of animations.current) animation.cancel();
    animations.current = [];

    const play = (element: Element, keyframes: Keyframe[], duration: number, delay = 0): void => {
      const animation = element.animate(keyframes, {
        duration: reducedMotion ? 0 : duration,
        delay: reducedMotion ? 0 : delay,
        easing: EASE,
        fill: 'backwards',
      });
      animations.current.push(animation);
    };

    for (const node of layoutNodes) {
      const element = nodeRefs.current.get(node.id);
      if (!element) continue;
      const nodeScale = node.id === selectedId ? 1.04 : 1;
      const transform = `translate(${node.x}px, ${node.y}px) scale(${nodeScale})`;
      const previous = positions.current.get(node.id);
      element.style.transform = transform;

      if (reducedMotion) {
        positions.current.set(node.id, {x: node.x, y: node.y, scale: nodeScale});
        continue;
      }

      const dragging = draggingId !== null;
      if (dragging) {
        positions.current.set(node.id, {x: node.x, y: node.y, scale: nodeScale});
        continue;
      }

      if (!previous) {
        play(
          element,
          [
            {opacity: 0, transform: `translate(${node.x - 8}px, ${node.y}px) scale(${nodeScale})`},
            {opacity: 1, transform},
          ],
          420,
          node.rank * 50,
        );
      } else if (previous.x !== node.x || previous.y !== node.y) {
        play(
          element,
          [
            {transform: `translate(${previous.x}px, ${previous.y}px) scale(${nodeScale})`},
            {transform},
          ],
          480,
        );
      } else if (previous.scale !== nodeScale) {
        play(
          element,
          [
            {transform: `translate(${node.x}px, ${node.y}px) scale(${previous.scale})`},
            {transform},
          ],
          180,
        );
      }

      positions.current.set(node.id, {x: node.x, y: node.y, scale: nodeScale});
    }

    const emphasisKey = emphasis.edges.join('\n');
    const emphasisChanged = seenEmphasis.current !== null && seenEmphasis.current !== emphasisKey;
    const activeEdges = new Set(emphasis.edges);
    const rankOf = new Map(layoutNodes.map((node) => [node.id, node.rank]));

    for (const edge of layoutEdges) {
      const path = edgeRefs.current.get(edge.id);
      const next = curves.get(edge.id);
      if (!path || next === undefined) continue;
      const previous = edgePaths.current.get(edge.id);
      const active = activeEdges.has(edge.id);

      if (previous && previous !== next && draggingId === null) {
        play(path, [{d: previous}, {d: next}], 480);
      }

      if (emphasisChanged && active && !reducedMotion) {
        const length = path.getTotalLength();
        path.style.strokeDasharray = `${length} ${length}`;
        const animation = path.animate([{strokeDashoffset: `${length}`}, {strokeDashoffset: '0'}], {
          duration: 640,
          delay: (rankOf.get(edge.from) ?? 0) * 48,
          easing: EASE,
          fill: 'forwards',
        });
        animation.onfinish = () => {
          path.style.strokeDashoffset = '0';
          path.style.strokeDasharray = edge.relation === 'bundle-includes' ? '4 5' : 'none';
        };
        animations.current.push(animation);
      } else {
        path.style.strokeDashoffset = '0';
        path.style.strokeDasharray = edge.relation === 'bundle-includes' ? '4 5' : 'none';
      }

      edgePaths.current.set(edge.id, next);
    }

    seenEmphasis.current = emphasisKey;

    return () => {
      for (const animation of animations.current) animation.cancel();
    };
  }, [curves, draggingId, emphasis.edges, layoutEdges, layoutNodes, reducedMotion, selectedId]);

  return (
    <div className="picture" style={{width, height}}>
      {ranks.map((rank) => (
        <div
          key={rank.index}
          className="band"
          data-odd={rank.index % 2 === 1 ? 'true' : 'false'}
          style={{left: rank.x, width: rank.width}}
        >
          <span className="rank-label">{rank.index}</span>
        </div>
      ))}
      <svg className="edges" width={width} height={height} aria-hidden="true">
        <defs>
          <marker
            id="arrow-ink"
            viewBox="0 0 8 8"
            markerWidth="6"
            markerHeight="6"
            refX="7"
            refY="4"
            orient="auto"
          >
            <path d="M0 0 L8 4 L0 8 Z" fill="#e7e1d4" />
          </marker>
          <marker
            id="arrow-bundle"
            viewBox="0 0 8 8"
            markerWidth="6"
            markerHeight="6"
            refX="7"
            refY="4"
            orient="auto"
          >
            <path d="M0 0 L8 4 L0 8 Z" fill="#b08972" />
          </marker>
        </defs>
        {layoutEdges.map((edge) => {
          const d = curves.get(edge.id);
          if (!d) return null;
          const active = emphasizedEdges.has(edge.id);
          return (
            <path
              key={edge.id}
              ref={(element) => {
                if (element) edgeRefs.current.set(edge.id, element);
                else edgeRefs.current.delete(edge.id);
              }}
              className="edge"
              d={d}
              data-relation={edge.relation}
              data-active={active ? 'true' : 'false'}
              data-cyclic={edge.cyclic ? 'true' : 'false'}
              markerEnd={
                edge.relation === 'bundle-includes' ? 'url(#arrow-bundle)' : 'url(#arrow-ink)'
              }
            />
          );
        })}
      </svg>
      {layoutNodes.map((node) => {
        const pkg = packages.get(node.id);
        if (!pkg) return null;
        const selected = node.id === selectedId;
        const dragging = node.id === draggingId;
        const dimmed =
          filter.length > 0 &&
          !node.id.toLowerCase().includes(filter) &&
          !(pkg.files ?? []).some((file) => file.toLowerCase().includes(filter));
        const emphasized = emphasizedNodes.has(node.id);
        const opacity = dimmed ? 0.2 : emphasized || selected ? 1 : 0.4;
        const shape = nodeShape(snapshot.kind, pkg);
        return (
          <button
            key={node.id}
            type="button"
            className="node"
            ref={(element) => {
              if (element) nodeRefs.current.set(node.id, element);
              else nodeRefs.current.delete(node.id);
            }}
            data-node-id={node.id}
            data-shape={shape ?? undefined}
            data-link={pkg.version === 'link' ? 'true' : undefined}
            data-rank={node.rank}
            data-selected={selected ? 'true' : 'false'}
            data-dimmed={dimmed ? 'true' : 'false'}
            data-emphasized={emphasized ? 'true' : 'false'}
            data-private={pkg.private ? 'true' : 'false'}
            data-dragging={dragging ? 'true' : 'false'}
            data-engine={
              !pkg.private && pkg.id === 'grafyx' && selectedId === null ? 'true' : 'false'
            }
            data-hovered={hoveredId === node.id ? 'true' : 'false'}
            aria-describedby={hoveredId === node.id ? 'atlas-tooltip' : undefined}
            style={{
              width: node.width,
              height: node.height,
              opacity,
              transform: `translate(${node.x}px, ${node.y}px) scale(${selected ? 1.04 : 1})`,
            }}
            onPointerEnter={() => onHover(node.id)}
            onPointerLeave={() => {
              if (dragRef.current?.id === node.id) return;
              onHover(null);
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.stopPropagation();
              try {
                event.currentTarget.setPointerCapture(event.pointerId);
              } catch {
                // A pointer that is not active cannot be captured. The move
                // handlers still follow client coordinates.
              }
              dragRef.current = {
                id: node.id,
                x: event.clientX,
                y: event.clientY,
                originX: event.clientX,
                originY: event.clientY,
                moved: false,
              };
              onDragStart(node.id);
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag || drag.id !== node.id) return;
              const travel = Math.hypot(event.clientX - drag.originX, event.clientY - drag.originY);
              if (!drag.moved && travel < 4) return;
              drag.moved = true;
              const picture = scale > 0 ? scale : 1;
              const dx = (event.clientX - drag.x) / picture;
              const dy = (event.clientY - drag.y) / picture;
              drag.x = event.clientX;
              drag.y = event.clientY;
              onMove(node.id, dx, dy);
            }}
            onPointerUp={(event) => {
              const drag = dragRef.current;
              if (!drag || drag.id !== node.id) return;
              dragRef.current = null;
              onDragEnd();
              if (drag.moved) suppressClick.current = true;
              else onSelect(node.id);
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            }}
            onPointerCancel={() => {
              if (dragRef.current?.id !== node.id) return;
              dragRef.current = null;
              onDragEnd();
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onMenu(node.id, event.clientX, event.clientY);
            }}
            onClick={(event) => {
              event.stopPropagation();
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              onSelect(node.id);
            }}
          >
            <span className="name">{pkg.id}</span>
            <span className="version">{nodeCaption(pkg, shape)}</span>
          </button>
        );
      })}
    </div>
  );
}

const boot = readBoot();
const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Missing root element.');
}

createRoot(rootElement).render(<AtlasApp key={boot.root} boot={boot} />);
