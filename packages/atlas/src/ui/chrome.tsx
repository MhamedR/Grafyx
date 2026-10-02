/**
 * Search, shortcut help, and the overview. The graph stays in `main.tsx`.
 */

import {useEffect, useId, useMemo, useRef, useState} from 'react';
import type {PackageNode} from '../model.js';
import {searchNodes, type NodeRole} from '../explore.js';
import type {AtlasLayout} from '../layout.js';

export function SearchPalette({
  nodes,
  onClose,
  onPick,
}: {
  readonly nodes: readonly PackageNode[];
  readonly onClose: () => void;
  readonly onPick: (id: string) => void;
}) {
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const hits = useMemo(() => searchNodes(nodes, text), [nodes, text]);
  const shown = text.trim().length > 0 ? hits : suggestions(nodes);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActive(0);
  }, [text]);

  const choose = (id: string | undefined): void => {
    if (!id) return;
    onPick(id);
    onClose();
  };

  return (
    <div
      className="palette"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="palette-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <p id={titleId} className="palette-title">
          Search the map
        </p>
        <input
          ref={inputRef}
          className="palette-input"
          role="combobox"
          aria-label="Search files, modules, packages, and paths"
          aria-expanded="true"
          aria-controls="atlas-search-results"
          aria-activedescendant={shown[active] ? `atlas-hit-${shown[active].id}` : undefined}
          placeholder="Name, path, or file"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onClose();
              return;
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((index) => (shown.length === 0 ? 0 : (index + 1) % shown.length));
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((index) =>
                shown.length === 0 ? 0 : (index - 1 + shown.length) % shown.length,
              );
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              choose(shown[active]?.id);
            }
          }}
        />
        <ul id="atlas-search-results" className="palette-list" role="listbox">
          {shown.length === 0 ? (
            <li className="palette-empty">No matching node.</li>
          ) : (
            shown.map((hit, index) => (
              <li key={hit.id} role="presentation">
                <button
                  id={`atlas-hit-${hit.id}`}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  data-active={index === active ? 'true' : 'false'}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(hit.id)}
                >
                  <span className="hit-name">{hit.id}</span>
                  <span className="hit-detail">{hit.detail}</span>
                </button>
              </li>
            ))
          )}
        </ul>
        <p className="palette-hint">Enter opens the node. Esc closes search.</p>
      </div>
    </div>
  );
}

export function ShortcutHelp({onClose}: {readonly onClose: () => void}) {
  const titleId = useId();

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="palette"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="palette-panel help-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <p id={titleId} className="palette-title">
          Keyboard
        </p>
        <dl className="help-list">
          {SHORTCUTS.map((item) => (
            <div key={item.keys}>
              <dt>{item.keys}</dt>
              <dd>{item.meaning}</dd>
            </div>
          ))}
        </dl>
        <button type="button" className="help-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

export function Minimap({
  layout,
  scale,
  panX,
  panY,
  roles,
  onPanTo,
}: {
  readonly layout: AtlasLayout;
  readonly scale: number;
  readonly panX: number;
  readonly panY: number;
  readonly roles: ReadonlyMap<string, NodeRole>;
  readonly onPanTo: (x: number, y: number) => void;
}) {
  const width = 168;
  const height = Math.min(120, Math.max(72, Math.round((layout.height / layout.width) * width)));
  const sx = width / layout.width;
  const sy = height / layout.height;
  const safe = scale > 0 ? scale : 1;
  const viewLeft = -panX / safe;
  const viewTop = -panY / safe;
  const viewWidth = layout.frameWidth / safe;
  const viewHeight = layout.frameHeight / safe;
  const rectX = Math.max(0, viewLeft);
  const rectY = Math.max(0, viewTop);
  const rectW = Math.max(8, Math.min(layout.width, viewLeft + viewWidth) - rectX);
  const rectH = Math.max(8, Math.min(layout.height, viewTop + viewHeight) - rectY);

  return (
    <div className="minimap" role="img" aria-label="Graph overview">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        onClick={(event) => {
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          const x = ((event.clientX - bounds.left) / bounds.width) * layout.width;
          const y = ((event.clientY - bounds.top) / bounds.height) * layout.height;
          onPanTo(x, y);
        }}
      >
        {layout.nodes.map((node) => {
          const role = roles.get(node.id) ?? 'default';
          if (role === 'hidden' || role === 'filtered') return null;
          return (
            <rect
              key={node.id}
              data-role={role}
              x={node.x * sx}
              y={node.y * sy}
              width={Math.max(2, node.width * sx)}
              height={Math.max(2, node.height * sy)}
            />
          );
        })}
        <rect
          className="minimap-view"
          x={rectX * sx}
          y={rectY * sy}
          width={rectW * sx}
          height={rectH * sy}
        />
      </svg>
    </div>
  );
}

function suggestions(nodes: readonly PackageNode[]): readonly {id: string; detail: string}[] {
  return nodes.slice(0, 8).map((node) => ({id: node.id, detail: node.path}));
}

const SHORTCUTS = [
  {keys: '⌘K  Ctrl K', meaning: 'Search'},
  {keys: 'Esc', meaning: 'Close a panel, or clear the selection'},
  {keys: 'F', meaning: 'Fit the graph'},
  {keys: '+  −', meaning: 'Zoom'},
  {keys: 'Arrows', meaning: 'Move to a dependent'},
  {keys: 'Shift arrows', meaning: 'Move to a dependency'},
  {keys: '?', meaning: 'This list'},
] as const;
