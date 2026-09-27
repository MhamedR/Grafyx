/**
 * Export the current picture as a diagrams.net file or a one-page PDF.
 *
 * The JPEG itself is painted in the browser. This module stays free of the DOM
 * so the same bytes can be checked from the test suite.
 */

import type {AtlasLayout} from './layout.js';
import {nodeCaption, nodeShape, type AtlasSnapshot, type NodeShape} from './model.js';
import type {Emphasis} from './session.js';
import {connectionCurve} from './ui/curves.js';

export interface ExportNode {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly opacity: number;
  readonly selected: boolean;
  readonly copper: boolean;
  readonly quietBorder: boolean;
  readonly link: boolean;
  readonly shape: NodeShape | 'package';
}

export interface ExportEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: string;
  readonly d: string;
  readonly active: boolean;
  readonly bundle: boolean;
}

export interface ExportRank {
  readonly index: number;
  readonly x: number;
  readonly width: number;
  readonly lift: boolean;
}

export interface ExportPicture {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly ranks: readonly ExportRank[];
  readonly nodes: readonly ExportNode[];
  readonly edges: readonly ExportEdge[];
}

const encoder = new TextEncoder();

export function exportFilename(root: string, lens: string, extension: string): string {
  const safe = projectName(root).replace(/[^\w.-]+/g, '-');
  return `${safe}-${lens}.${extension}`;
}

export function buildExportPicture(input: {
  readonly root: string;
  readonly lens: string;
  readonly snapshot: AtlasSnapshot;
  readonly layout: AtlasLayout;
  readonly emphasis: Emphasis;
  readonly selectedId: string | null;
  readonly filter: string;
}): ExportPicture {
  const packages = new Map(input.snapshot.nodes.map((node) => [node.id, node]));
  const emphasizedNodes = new Set(input.emphasis.nodes);
  const emphasizedEdges = new Set(input.emphasis.edges);
  const filter = input.filter.trim().toLowerCase();
  const placed = new Map(input.layout.nodes.map((node) => [node.id, node]));
  const base = projectName(input.root);

  const nodes: ExportNode[] = [];

  for (const node of input.layout.nodes) {
    const pkg = packages.get(node.id);
    if (!pkg) continue;
    const selected = node.id === input.selectedId;
    const dimmed =
      filter.length > 0 &&
      !node.id.toLowerCase().includes(filter) &&
      !(pkg.files ?? []).some((file) => file.toLowerCase().includes(filter));
    const scale = selected ? 1.04 : 1;
    const width = node.width * scale;
    const height = node.height * scale;
    const copper = selected || (!pkg.private && pkg.id === 'grafyx' && input.selectedId === null);
    const shape = nodeShape(input.snapshot.kind, pkg) ?? 'package';
    nodes.push({
      id: pkg.id,
      label: pkg.id,
      detail: nodeCaption(pkg, shape === 'package' ? null : shape),
      shape,
      x: node.x - (width - node.width) / 2,
      y: node.y - (height - node.height) / 2,
      width,
      height,
      opacity: dimmed ? 0.2 : emphasizedNodes.has(node.id) || selected ? 1 : 0.4,
      selected,
      copper,
      quietBorder: pkg.private && !copper,
      link: pkg.version === 'link',
    });
  }

  const edges: ExportEdge[] = [];

  for (const edge of input.layout.edges) {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) continue;
    const bend =
      edge.relation === 'bundle-includes' &&
      input.layout.edges.some(
        (other) =>
          other.id !== edge.id &&
          other.from === edge.from &&
          other.to === edge.to &&
          other.relation !== edge.relation,
      )
        ? 8
        : 0;
    edges.push({
      from: edge.from,
      to: edge.to,
      relation: edge.relation,
      d: connectionCurve(from, to, bend),
      active: emphasizedEdges.has(edge.id),
      bundle: edge.relation === 'bundle-includes',
    });
  }

  return {
    name: `${base} ${input.lens}`,
    width: input.layout.width,
    height: input.layout.height,
    ranks: input.layout.ranks.map((rank) => ({
      index: rank.index,
      x: rank.x,
      width: rank.width,
      lift: rank.index % 2 === 1,
    })),
    nodes,
    edges,
  };
}

export function toDrawio(picture: ExportPicture): string {
  const nodeIds = new Map(picture.nodes.map((node, index) => [node.id, `n${index}`]));
  const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];

  picture.ranks.forEach((rank, index) => {
    const fill = rank.lift ? '#1a1914' : '#12110e';
    cells.push(
      `<mxCell id="r${index}" value="${rank.index}" style="rounded=0;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=none;fontColor=#8d877c;fontSize=10;align=left;verticalAlign=top;spacingLeft=4;spacingTop=8;fontFamily=Outfit;connectable=0;movable=0;resizable=0;locked=1;" vertex="1" parent="1">`,
      `<mxGeometry x="${num(rank.x)}" y="0" width="${num(rank.width)}" height="${num(picture.height)}" as="geometry"/>`,
      '</mxCell>',
    );
  });

  picture.edges.forEach((edge, index) => {
    const source = nodeIds.get(edge.from);
    const target = nodeIds.get(edge.to);
    if (!source || !target) return;
    const color = edge.bundle ? '#b08972' : '#e7e1d4';
    const dashed = edge.bundle ? 'dashed=1;dashPattern=4 5;' : '';
    const opacity = edge.active ? '' : 'opacity=15;';
    cells.push(
      `<mxCell id="e${index}" value="${xml(edge.relation)}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;strokeWidth=1;strokeColor=${color};fontColor=#8d877c;fontSize=10;${dashed}${opacity}exitX=1;exitY=0.5;entryX=0;entryY=0.5;" edge="1" parent="1" source="${source}" target="${target}">`,
      '<mxGeometry relative="1" as="geometry"/>',
      '</mxCell>',
    );
  });

  for (const node of picture.nodes) {
    const id = nodeIds.get(node.id);
    if (!id) continue;
    const stroke = node.copper
      ? '#e07a45'
      : node.quietBorder
        ? '#2a2822'
        : node.link
          ? '#e07a45'
          : node.shape === 'folder'
            ? '#b08972'
            : node.shape === 'file'
              ? '#8d877c'
              : '#3a362e';
    const font = node.selected ? 'Fraunces' : 'Outfit';
    const opacity = node.opacity >= 1 ? '' : `opacity=${Math.round(node.opacity * 100)};`;
    const fill =
      node.shape === 'folder' ? '#3a3128' : node.shape === 'file' ? '#1c2124' : '#18160f';
    const form =
      node.shape === 'folder'
        ? 'shape=mxgraph.basic.folder;tabWidth=28;tabHeight=10;tabPosition=left;'
        : node.shape === 'file'
          ? 'shape=mxgraph.basic.folded_corner;size=14;'
          : 'rounded=0;';
    const dotted = node.link ? 'dashed=1;dashPattern=1 2;' : '';
    const label = `&lt;div style=&quot;text-align:left;line-height:1.35;&quot;&gt;${xml(node.label)}&lt;br&gt;&lt;span style=&quot;font-size:11px;color:#8d877c;&quot;&gt;${xml(node.detail)}&lt;/span&gt;&lt;/div&gt;`;
    cells.push(
      `<mxCell id="${id}" value="${label}" style="${form}${dotted}whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};fontColor=#e7e1d4;fontFamily=${font};align=left;verticalAlign=middle;spacingLeft=12;fontSize=14;${opacity}" vertex="1" parent="1">`,
      `<mxGeometry x="${num(node.x)}" y="${num(node.y)}" width="${num(node.width)}" height="${num(node.height)}" as="geometry"/>`,
      '</mxCell>',
    );
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<mxfile host="grafyx-atlas" type="atlas">',
    `<diagram id="atlas" name="${xml(picture.name)}">`,
    `<mxGraphModel dx="${Math.round(picture.width)}" dy="${Math.round(picture.height)}" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" pageWidth="${Math.round(picture.width)}" pageHeight="${Math.round(picture.height)}" background="#12110e" math="0" shadow="0">`,
    '<root>',
    ...cells,
    '</root>',
    '</mxGraphModel>',
    '</diagram>',
    '</mxfile>',
    '',
  ].join('\n');
}

/**
 * Wraps a JPEG in a one-page PDF. `pageWidth` and `pageHeight` are the
 * picture size in points; the JPEG pixel size is the image dictionary size.
 */
export function jpegToPdf(
  jpeg: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  pageWidth: number,
  pageHeight: number,
): Uint8Array {
  const width = Math.max(1, Math.round(pageWidth));
  const height = Math.max(1, Math.round(pageHeight));
  const pixelsWide = Math.max(1, Math.round(imageWidth));
  const pixelsHigh = Math.max(1, Math.round(imageHeight));
  const content = `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n',
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>\nendobj\n`,
    `4 0 obj\n<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream\nendobj\n`,
  ];

  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (data: Uint8Array | string): number => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    chunks.push(bytes);
    const start = length;
    length += bytes.length;
    return start;
  };

  const offsets = [0, 0, 0, 0, 0, 0];
  push('%PDF-1.4\n');
  objects.forEach((object, index) => {
    offsets[index + 1] = push(object);
  });
  offsets[5] = push(
    `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pixelsWide} /Height ${pixelsHigh} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  );
  push(jpeg);
  push('\nendstream\nendobj\n');

  const entries = offsets
    .map((offset, index) =>
      index === 0 ? '0000000000 65535 f \n' : `${String(offset).padStart(10, '0')} 00000 n \n`,
    )
    .join('');
  const xrefAt = length;
  push(`xref\n0 6\n${entries}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

function projectName(root: string): string {
  const parts = root.split('/');
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part && part.length > 0) return part;
  }
  return 'atlas';
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function num(value: number): string {
  return String(Math.round(value * 10) / 10);
}
