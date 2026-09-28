/**
 * Statistics for the project on screen: weight, reach, coupling, and the scan.
 */

import {useState} from 'react';
import {formatBytes, type AtlasSnapshot} from '../model.js';
import {structureStats, type Coupling, type StructureStats} from '../stats.js';

export function StatsBoard({
  snapshot,
  onSelect,
}: {
  readonly snapshot: AtlasSnapshot;
  readonly onSelect: (id: string) => void;
}) {
  const stats = structureStats(snapshot);
  const hasWeight = stats.largestFiles.length > 0;

  return (
    <div className="stats" data-stats onClick={(event) => event.stopPropagation()}>
      <ScanSummary stats={stats} />
      {hasWeight ? (
        <LargestFiles
          rows={stats.largestFiles.map((file) => {
            const slash = file.path.lastIndexOf('/');
            const name = slash === -1 ? file.path : file.path.slice(slash + 1);
            const where = slash === -1 ? '' : file.path.slice(0, slash);
            return {
              key: file.path,
              id: file.nodeId,
              label: name,
              hint: where,
              value: file.bytes,
              display: `${formatBytes(file.bytes)} · ${file.lines} ${file.lines === 1 ? 'line' : 'lines'}`,
            };
          })}
          onSelect={onSelect}
        />
      ) : (
        <p className="stats-empty">This picture has no measured source files.</p>
      )}
      {stats.blast.length > 0 ? (
        <ColumnChart
          title="Change reach"
          caption="How many other parts must move if this one changes."
          rows={stats.blast.map((part) => ({
            key: part.id,
            id: part.id,
            label: part.id,
            value: part.reached,
            display: `${part.reached} ${part.reached === 1 ? 'part' : 'parts'}`,
          }))}
          onSelect={onSelect}
        />
      ) : null}
      {stats.weight.length > 0 ? (
        <Chart
          title="Weight by part"
          caption="Bytes rolled up to each node on the map."
          rows={stats.weight.map((part) => ({
            key: part.id,
            id: part.id,
            label: part.id,
            value: part.bytes,
            display: `${formatBytes(part.bytes)} · ${part.files} ${part.files === 1 ? 'file' : 'files'}`,
          }))}
          onSelect={onSelect}
        />
      ) : null}
      {stats.coupling.length > 0 ? (
        <CouplingChart rows={stats.coupling} onSelect={onSelect} />
      ) : null}
    </div>
  );
}

function ScanSummary({stats}: {readonly stats: StructureStats}) {
  const scan = stats.scan;
  const rate =
    scan && scan.durationMs > 0
      ? `${formatBytes((scan.byteCount / scan.durationMs) * 1000)}/s`
      : null;

  return (
    <div className="scan-stats">
      <ScanFigure value={scan ? `${scan.durationMs} ms` : '—'} label="Scan" />
      <ScanFigure value={String(scan?.fileCount ?? stats.totals.files)} label="Files" />
      <ScanFigure value={formatBytes(scan?.byteCount ?? stats.totals.bytes)} label="Read" />
      <ScanFigure value={String(scan?.lineCount ?? stats.totals.lines)} label="Lines" />
      {rate ? <ScanFigure value={rate} label="Throughput" /> : null}
    </div>
  );
}

function ScanFigure({value, label}: {readonly value: string; readonly label: string}) {
  return (
    <p>
      <span>{value}</span>
      <small>{label}</small>
    </p>
  );
}

interface ChartRow {
  readonly key: string;
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly value: number;
  readonly display: string;
}

function LargestFiles({
  rows,
  onSelect,
}: {
  readonly rows: readonly ChartRow[];
  readonly onSelect: (id: string) => void;
}) {
  const [active, setActive] = useState<number | null>(null);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  const size = 168;
  const stroke = 18;
  const radius = (size - stroke) / 2;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;
  const gap = rows.length > 1 ? 2.5 : 0;
  let cursor = 0;
  const slices = rows.map((row) => {
    const sweep = total === 0 ? 0 : (row.value / total) * circumference;
    const slice = {length: Math.max(0, sweep - gap), offset: cursor};
    cursor += sweep;
    return slice;
  });
  const shown = active === null ? null : rows[active];

  return (
    <section className="chart">
      <h2>Largest files</h2>
      <p>Share of bytes among the heaviest source files.</p>
      <div className="donut">
        <div className="donut-figure">
          <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            role="img"
            aria-label="Largest files by bytes"
          >
            <g transform={`rotate(-90 ${center} ${center})`}>
              {slices.map((slice, index) =>
                slice.length <= 0 ? null : (
                  <circle
                    key={rows[index]?.key}
                    cx={center}
                    cy={center}
                    r={radius}
                    fill="none"
                    strokeWidth={stroke}
                    strokeDasharray={`${slice.length} ${circumference - slice.length}`}
                    strokeDashoffset={-slice.offset}
                    style={{
                      stroke: `var(--slice-${index})`,
                      opacity: active === null || active === index ? 1 : 0.28,
                    }}
                    onMouseEnter={() => setActive(index)}
                    onMouseLeave={() => setActive(null)}
                    onClick={() => {
                      const id = rows[index]?.id;
                      if (id) onSelect(id);
                    }}
                  />
                ),
              )}
            </g>
          </svg>
          <div className="donut-center">
            <strong>{formatBytes(shown ? shown.value : total)}</strong>
            <span>{shown ? shown.label : 'shown'}</span>
          </div>
        </div>
        <ul className="donut-key">
          {rows.map((row, index) => (
            <li key={row.key}>
              <button
                type="button"
                data-active={active === index ? 'true' : 'false'}
                onClick={() => onSelect(row.id)}
                onMouseEnter={() => setActive(index)}
                onMouseLeave={() => setActive(null)}
              >
                <span className="donut-swatch" style={{background: `var(--slice-${index})`}} />
                <span
                  className="chart-label"
                  title={row.hint ? `${row.hint}/${row.label}` : row.label}
                >
                  <span className="chart-name">{row.label}</span>
                  {row.hint ? <span className="chart-hint">{row.hint}</span> : null}
                </span>
                <span className="chart-value">{row.display}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function ColumnChart({
  title,
  caption,
  rows,
  onSelect,
}: {
  readonly title: string;
  readonly caption: string;
  readonly rows: readonly ChartRow[];
  readonly onSelect: (id: string) => void;
}) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...rows.map((row) => row.value));

  return (
    <section className="chart">
      <h2>{title}</h2>
      <p>{caption}</p>
      <div className="columns">
        {rows.map((row, index) => (
          <button
            key={row.key}
            type="button"
            title={`${row.label} · ${row.display}`}
            data-active={active === index ? 'true' : 'false'}
            onClick={() => onSelect(row.id)}
            onMouseEnter={() => setActive(index)}
            onMouseLeave={() => setActive(null)}
          >
            <span className="column-value">{row.value}</span>
            <span className="column-plot">
              <span className="column-bar" style={{height: `${(row.value / max) * 100}%`}} />
            </span>
            <span className="column-label">{row.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function Chart({
  title,
  caption,
  rows,
  onSelect,
}: {
  readonly title: string;
  readonly caption: string;
  readonly rows: readonly {
    key: string;
    id: string;
    label: string;
    hint?: string;
    value: number;
    display: string;
  }[];
  readonly onSelect: (id: string) => void;
}) {
  const max = Math.max(1, ...rows.map((row) => row.value));

  return (
    <section className="chart">
      <h2>{title}</h2>
      <p>{caption}</p>
      <ul>
        {rows.map((row) => (
          <li key={row.key}>
            <button type="button" onClick={() => onSelect(row.id)}>
              <span
                className="chart-label"
                title={row.hint ? `${row.hint}/${row.label}` : row.label}
              >
                <span className="chart-name">{row.label}</span>
                {row.hint ? <span className="chart-hint">{row.hint}</span> : null}
              </span>
              <span className="chart-track">
                <span className="chart-fill" style={{width: `${(row.value / max) * 100}%`}} />
              </span>
              <span className="chart-value">{row.display}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CouplingChart({
  rows,
  onSelect,
}: {
  readonly rows: readonly Coupling[];
  readonly onSelect: (id: string) => void;
}) {
  const max = Math.max(1, ...rows.map((row) => row.inDegree + row.outDegree));

  return (
    <section className="chart">
      <h2>Direct coupling</h2>
      <p>Copper is what this part stands on. The pale bar is what comes after it.</p>
      <ul>
        {rows.map((row) => {
          const total = row.inDegree + row.outDegree;
          const scale = (total / max) * 100;
          const incoming = total === 0 ? 0 : (row.inDegree / total) * 100;
          const outgoing = total === 0 ? 0 : (row.outDegree / total) * 100;

          return (
            <li key={row.id}>
              <button type="button" onClick={() => onSelect(row.id)}>
                <span className="chart-label">{row.id}</span>
                <span className="chart-track">
                  <span className="chart-stack" style={{width: `${scale}%`}}>
                    <span className="chart-in" style={{width: `${incoming}%`}} />
                    <span className="chart-out" style={{width: `${outgoing}%`}} />
                  </span>
                </span>
                <span className="chart-value">
                  {row.inDegree} in · {row.outDegree} out
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
