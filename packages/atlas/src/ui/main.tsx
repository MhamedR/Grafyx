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
  type PointerEvent as ReactPointerEvent,
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
  fileCountLabel,
  filesForList,
  formatBytes,
  nodeCaption,
  nodeShape,
  type AtlasBoot,
  type AtlasSnapshot,
  type NodeShape,
  type PackageNode,
} from '../model.js';
import type {AtlasLayout, PlacedEdge, PlacedNode} from '../layout.js';
import {
  connectAtlasSession,
  createAtlasSession,
  viewFromSearch,
  type AtlasConnection,
  type AtlasSession,
  type Emphasis,
} from '../session.js';
import {buildExportPicture, exportFilename} from '../export.js';
import {connectionCurve} from './curves.js';
import {savePicture} from './paint.js';
import {StatsBoard} from './stats.js';

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.75;
const ZOOM_STEP = 1.25;
const ORDER_MIN_HEIGHT = 96;
const ORDER_MAX_HEIGHT = 520;
const TOOLTIP_SHOW_MS = 380;
const TOOLTIP_SWITCH_MS = 220;
const TOOLTIP_CLOSE_MS = 140;

interface PictureView {
  readonly zoom: number;
  readonly panX: number;
  readonly panY: number;
}

function baseFit(layout: AtlasLayout): number {
  if (layout.width <= 0 || layout.height <= 0) return 1;
  return Math.min(1, layout.frameWidth / layout.width, layout.frameHeight / layout.height);
}

function viewScale(layout: AtlasLayout, zoom: number): number {
  return baseFit(layout) * zoom;
}

function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

function clampPan(
  layout: AtlasLayout,
  scale: number,
  panX: number,
  panY: number,
): Pick<PictureView, 'panX' | 'panY'> {
  const minX = Math.min(0, layout.frameWidth - layout.width * scale);
  const minY = Math.min(0, layout.frameHeight - layout.height * scale);
  return {
    panX: Math.min(0, Math.max(minX, panX)),
    panY: Math.min(0, Math.max(minY, panY)),
  };
}

function canPan(layout: AtlasLayout, zoom: number): boolean {
  const scale = viewScale(layout, zoom);
  return (
    layout.width * scale > layout.frameWidth + 1 || layout.height * scale > layout.frameHeight + 1
  );
}

function applyZoom(
  layout: AtlasLayout,
  view: PictureView,
  factor: number,
  anchorX: number,
  anchorY: number,
): PictureView {
  const zoom = clampZoom(view.zoom * factor);
  if (zoom === view.zoom) return view;
  const currentScale = viewScale(layout, view.zoom);
  const nextScale = viewScale(layout, zoom);
  const marginTop = Math.max(0, (layout.frameHeight - layout.height * currentScale) / 2);
  const nextMargin = Math.max(0, (layout.frameHeight - layout.height * nextScale) / 2);
  const safe = currentScale > 0 ? currentScale : 1;
  const layoutX = (anchorX - view.panX) / safe;
  const layoutY = (anchorY - marginTop - view.panY) / safe;
  return {
    zoom,
    ...clampPan(
      layout,
      nextScale,
      anchorX - layoutX * nextScale,
      anchorY - nextMargin - layoutY * nextScale,
    ),
  };
}

function orderLimit(viewportHeight: number): number {
  return Math.min(ORDER_MAX_HEIGHT, Math.max(ORDER_MIN_HEIGHT, Math.round(viewportHeight * 0.55)));
}

function clampOrderHeight(height: number, viewportHeight: number): number {
  return Math.min(orderLimit(viewportHeight), Math.max(ORDER_MIN_HEIGHT, Math.round(height)));
}

function viewAtRest(view: PictureView): boolean {
  return Math.abs(view.zoom - 1) < 0.01 && view.panX === 0 && view.panY === 0;
}

/** Project root, then the open depth, then the selected part. */
function atlasLocation(root: string, crumbs: readonly string[], node: PackageNode | null): string {
  const sep = root.includes('\\') ? '\\' : '/';
  const base = root.replace(/[/\\]+$/, '');
  if (node && node.path.length > 0 && node.path !== '.') {
    const relative = node.path.split('/').join(sep);
    return `${base}${sep}${relative}`;
  }
  if (crumbs.length === 0) return root;
  return [base, ...crumbs].join(sep);
}

let measureCanvas: CanvasRenderingContext2D | null = null;

function textWidth(text: string, font: string, letterSpacing: number): number {
  measureCanvas ??= document.createElement('canvas').getContext('2d');
  if (!measureCanvas) return text.length * 8;
  measureCanvas.font = font;
  const width = measureCanvas.measureText(text).width;
  return letterSpacing > 0 && text.length > 1 ? width + letterSpacing * (text.length - 1) : width;
}

/** Keep the start and the end of a path, which is the part that changes. */
function ellipsisMiddle(
  text: string,
  maxWidth: number,
  font: string,
  letterSpacing: number,
): string {
  if (maxWidth <= 0 || textWidth(text, font, letterSpacing) <= maxWidth) return text;
  const mark = '…';
  let low = 0;
  let high = text.length;
  let best = mark;
  while (low <= high) {
    const count = (low + high) >> 1;
    const head = Math.ceil(count / 2);
    const tail = count - head;
    const next =
      tail <= 0
        ? `${text.slice(0, head)}${mark}`
        : `${text.slice(0, head)}${mark}${text.slice(-tail)}`;
    if (textWidth(next, font, letterSpacing) <= maxWidth) {
      best = next;
      low = count + 1;
    } else high = count - 1;
  }
  return best;
}

function copyWithCommand(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.left = '-999px';
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  return copied;
}

function copyText(text: string): Promise<void> {
  const legacy = (): Promise<void> =>
    copyWithCommand(text)
      ? Promise.resolve()
      : Promise.reject(new Error('Could not copy the path.'));
  if (!navigator.clipboard?.writeText) return legacy();
  return navigator.clipboard.writeText(text).catch(() => legacy());
}

function LocationPath({location}: {readonly location: string}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [shown, setShown] = useState(location);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [location]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useLayoutEffect(() => {
    const button = ref.current;
    if (!button) return;
    const fit = (): void => {
      const style = getComputedStyle(button);
      const font = style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const spacing = Number.parseFloat(style.letterSpacing);
      setShown(
        ellipsisMiddle(location, button.clientWidth, font, Number.isFinite(spacing) ? spacing : 0),
      );
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(button);
    return () => observer.disconnect();
  }, [location]);

  return (
    <>
      <button
        ref={ref}
        type="button"
        className="root-path"
        title={location}
        aria-label={copied ? 'Path copied' : `Copy path ${location}`}
        onClick={(event) => {
          event.stopPropagation();
          void copyText(location).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {shown}
      </button>
      {copied ? (
        <span className="path-copied" role="status">
          copied
        </span>
      ) : null}
    </>
  );
}

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
  const [camera, setCamera] = useState<PictureView>({zoom: 1, panX: 0, panY: 0});
  const [pictureMoving, setPictureMoving] = useState(false);
  const [orderOpen, setOrderOpen] = useState(true);
  const [orderHeight, setOrderHeight] = useState<number | null>(null);
  const [tipId, setTipId] = useState<string | null>(null);
  const crumbs = useStore(stores.crumbs);
  const boardRef = useRef(board);
  const layoutRef = useRef(layout);
  const cameraRef = useRef(camera);
  const moveTimer = useRef<number | null>(null);
  const panDrag = useRef<{pointer: number; x: number; y: number; moved: boolean} | null>(null);
  boardRef.current = board;
  layoutRef.current = layout;
  cameraRef.current = camera;

  const appliedView = useRef(false);
  useLayoutEffect(() => {
    if (appliedView.current || !snapshot) return;
    appliedView.current = true;
    const view = viewFromSearch(window.location.search);
    session.runtime.batch(() => {
      if (view.lens) session.lens.value = view.lens;
      if (view.packageId && snapshot.nodes.some((node) => node.id === view.packageId)) {
        session.selectedId.value = view.packageId;
      }
    });
    if (view.stats) setBoard('stats');
  }, [session, snapshot]);

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

  useEffect(() => {
    if (!layout) return;
    setCamera((current) => {
      const pan = clampPan(layout, viewScale(layout, current.zoom), current.panX, current.panY);
      if (pan.panX === current.panX && pan.panY === current.panY) return current;
      return {...current, ...pan};
    });
  }, [layout]);

  useEffect(() => {
    if (draggingId !== null || menu !== null || board !== 'map') {
      setTipId(null);
      return;
    }

    const timer = window.setTimeout(
      () => setTipId(hoveredId),
      hoveredId ? (tipId ? TOOLTIP_SWITCH_MS : TOOLTIP_SHOW_MS) : TOOLTIP_CLOSE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [board, draggingId, hoveredId, menu, tipId]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const onWheel = (event: WheelEvent): void => {
      const currentLayout = layoutRef.current;
      if (boardRef.current !== 'map' || !currentLayout || currentLayout.nodes.length === 0) return;
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * 0.0015);
      setPictureMoving(true);
      setCamera((current) =>
        applyZoom(
          currentLayout,
          current,
          factor,
          event.clientX - rect.left,
          event.clientY - rect.top,
        ),
      );
      if (moveTimer.current !== null) window.clearTimeout(moveTimer.current);
      moveTimer.current = window.setTimeout(() => setPictureMoving(false), 140);
    };

    stage.addEventListener('wheel', onWheel, {passive: false});
    return () => {
      stage.removeEventListener('wheel', onWheel);
      if (moveTimer.current !== null) window.clearTimeout(moveTimer.current);
    };
  }, []);

  const buildOrder = useStore(stores.order);
  const selected = snapshot?.nodes.find((node) => node.id === selectedId) ?? null;
  const tipNode = snapshot?.nodes.find((node) => node.id === tipId) ?? null;
  const tipPlace = layout?.nodes.find((node) => node.id === tipId) ?? null;
  const scale = layout ? viewScale(layout, camera.zoom) : 1;
  const pannable = layout ? canPan(layout, camera.zoom) : false;

  const zoomBy = (factor: number): void => {
    const stage = stageRef.current;
    if (!layout || !stage) return;
    const rect = stage.getBoundingClientRect();
    setPictureMoving(false);
    setCamera((current) => applyZoom(layout, current, factor, rect.width / 2, rect.height / 2));
  };

  const onStagePointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if (
      event.button !== 0 ||
      boardRef.current !== 'map' ||
      !layout ||
      !canPan(layout, cameraRef.current.zoom)
    ) {
      return;
    }
    const target = event.target;
    if (
      !(target instanceof Element) ||
      target.closest('.node, .zoom, .stats, .field-message, button, a, input')
    ) {
      return;
    }
    panDrag.current = {pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false};
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that is not active cannot be captured. The move handlers
      // still follow client coordinates.
    }
  };

  const onStagePointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = panDrag.current;
    if (!drag || drag.pointer !== event.pointerId || !layout) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    drag.x = event.clientX;
    drag.y = event.clientY;
    setPictureMoving(true);
    setCamera((current) => ({
      ...current,
      ...clampPan(layout, viewScale(layout, current.zoom), current.panX + dx, current.panY + dy),
    }));
  };

  const onStagePointerUp = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = panDrag.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.moved) panDrag.current = null;
    setPictureMoving(false);
  };

  const resizeOrder = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const footer = handle.closest('footer');
    const startY = event.clientY;
    const startHeight = footer?.getBoundingClientRect().height ?? ORDER_MIN_HEIGHT;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that is not active cannot be captured. The move handlers
      // still follow client coordinates.
    }
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = 'ns-resize';

    const move = (ev: PointerEvent): void => {
      setOrderHeight(clampOrderHeight(startHeight + (startY - ev.clientY), window.innerHeight));
    };
    const finish = (ev: PointerEvent): void => {
      if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      document.body.style.cursor = previousCursor;
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  };
  const acyclic = buildOrder.kind === 'order';
  const questions = snapshot?.kind === 'source' ? SOURCE_LENS_QUESTION : LENS_QUESTION;
  const question =
    board === 'stats'
      ? 'Where the weight sits, and how far a change reaches.'
      : lens === 'cycles' && acyclic
        ? CYCLE_CLEAR
        : questions[lens];
  const filter = query.trim().toLowerCase();
  const location = atlasLocation(boot.root, crumbs, selected);
  const showZoom = board === 'map' && layout !== null && layout.nodes.length > 0;
  const zoomPercent = Math.round(camera.zoom * 100);

  return (
    <div className="app" data-reduced={reducedMotion ? 'true' : 'false'}>
      <header className="header">
        <div className="header-top">
          <div className="brand">
            <h1 className="wordmark">
              grafyx<span className="slash">/</span>atlas
            </h1>
            <LocationPath location={location} />
          </div>
          <div className="header-tools">
            {showZoom ? (
              <div className="zoom" role="group" aria-label="Zoom">
                <button
                  type="button"
                  aria-label="Zoom out"
                  title="Zoom out"
                  disabled={camera.zoom <= ZOOM_MIN + 0.001}
                  onClick={() => zoomBy(1 / ZOOM_STEP)}
                >
                  −
                </button>
                <button
                  type="button"
                  className="zoom-level"
                  aria-label={`Reset zoom, ${zoomPercent}%`}
                  title="Reset zoom"
                  disabled={viewAtRest(camera)}
                  onClick={() => {
                    setPictureMoving(false);
                    setCamera({zoom: 1, panX: 0, panY: 0});
                  }}
                >
                  {zoomPercent}%
                </button>
                <button
                  type="button"
                  aria-label="Zoom in"
                  title="Zoom in"
                  disabled={camera.zoom >= ZOOM_MAX - 0.001}
                  onClick={() => zoomBy(ZOOM_STEP)}
                >
                  +
                </button>
              </div>
            ) : null}
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
                            error instanceof Error
                              ? error.message
                              : 'Could not export the picture.',
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
        data-pannable={pannable ? 'true' : 'false'}
        data-panning={pictureMoving && panDrag.current?.moved ? 'true' : 'false'}
        data-order={orderOpen ? 'open' : 'closed'}
        onClick={() => {
          if (panDrag.current?.moved) {
            panDrag.current = null;
            return;
          }
          setMenu(null);
          setExportOpen(false);
          session.select(null);
        }}
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onPointerCancel={onStagePointerUp}
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
          <Fitted
            layout={layout}
            scale={scale}
            panX={camera.panX}
            panY={camera.panY}
            moving={pictureMoving}
          >
            <Graph
              snapshot={snapshot}
              layoutNodes={layout.nodes}
              layoutEdges={layout.edges}
              ranks={layout.ranks}
              width={layout.width}
              height={layout.height}
              scale={scale}
              emphasis={emphasis}
              selectedId={selectedId}
              hoveredId={hoveredId}
              describedId={tipId}
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
        {board === 'map' && tipNode && snapshot && draggingId === null && menu === null ? (
          <PackageTooltip
            key={tipNode.id}
            snapshot={snapshot}
            node={tipNode}
            rank={tipPlace?.rank ?? null}
            x={tipPlace?.x ?? 0}
            y={tipPlace?.y ?? 0}
            reducedMotion={reducedMotion}
          />
        ) : null}
      </main>
      <footer
        className="footer"
        data-collapsed={orderOpen ? 'false' : 'true'}
        style={orderOpen && orderHeight !== null ? {height: orderHeight} : undefined}
      >
        {orderOpen ? (
          <>
            <div
              className="order-resize"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize order"
              onPointerDown={resizeOrder}
            />
            <ol className="filmstrip" id="order-panel">
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
          </>
        ) : null}
        <button
          type="button"
          className="order-toggle"
          aria-expanded={orderOpen}
          aria-controls="order-panel"
          aria-label={orderOpen ? 'Hide order' : 'Show order'}
          onClick={() => setOrderOpen((open) => !open)}
        >
          {orderOpen ? 'hide' : 'order'}
        </button>
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

function Fitted({
  layout,
  scale,
  panX,
  panY,
  moving,
  children,
}: {
  readonly layout: AtlasLayout;
  readonly scale: number;
  readonly panX: number;
  readonly panY: number;
  readonly moving: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div
      className="fit"
      data-moving={moving ? 'true' : 'false'}
      style={{width: layout.frameWidth, height: layout.frameHeight}}
    >
      <div
        className="fit-scale"
        style={{
          width: layout.width * scale,
          height: layout.height * scale,
          marginTop: Math.max(0, (layout.frameHeight - layout.height * scale) / 2),
          transform: `translate(${panX}px, ${panY}px)`,
        }}
      >
        <div
          style={{
            width: layout.width,
            height: layout.height,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function FolderFiles({
  node,
  shape,
  variant,
}: {
  readonly node: PackageNode;
  readonly shape: NodeShape | null;
  readonly variant: 'inspector' | 'tooltip';
}) {
  const files = node.files ?? [];
  const listed = filesForList(node);
  if (shape !== 'folder' || files.length === 0) return null;

  return (
    <div className="split">
      <p className="split-label">Files</p>
      {listed ? (
        <ul className={variant === 'tooltip' ? 'tooltip-files' : undefined}>
          {listed.map((file) => {
            if (variant === 'tooltip') return <li key={file}>{file}</li>;
            const measure = node.measures?.find((item) => item.path === file);
            return (
              <li key={file}>
                {file}
                {measure ? ` · ${formatBytes(measure.bytes)}` : ''}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="file-count" data-file-count={files.length}>
          {fileCountLabel(files.length)}
        </p>
      )}
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
      <FolderFiles node={node} shape={shape} variant="inspector" />
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
  reducedMotion,
}: {
  readonly snapshot: AtlasSnapshot;
  readonly node: PackageNode;
  readonly rank: number | null;
  readonly x: number;
  readonly y: number;
  readonly reducedMotion: boolean;
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{left: number; top: number; place: 'above' | 'below'} | null>(
    null,
  );
  const [shown, setShown] = useState(false);

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

  useEffect(() => {
    if (!box) return;
    if (reducedMotion) {
      setShown(true);
      return;
    }
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [box, reducedMotion]);

  const incoming = snapshot.edges.filter((edge) => edge.to === node.id);
  const outgoing = snapshot.edges.filter((edge) => edge.from === node.id);
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
      data-shown={shown ? 'true' : 'false'}
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
      <FolderFiles node={node} shape={shape} variant="tooltip" />
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
  describedId,
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
  readonly describedId: string | null;
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
            aria-describedby={describedId === node.id ? 'atlas-tooltip' : undefined}
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
