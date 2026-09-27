import {test} from 'node:test';
import {assert} from '../../../test/assert.js';
import {buildExportPicture, exportFilename, jpegToPdf, toDrawio} from '../src/export.js';
import {nodeCaption, nodeShape} from '../src/model.js';
import type {AtlasLayout} from '../src/layout.js';
import {atlasEdgeId, type AtlasSnapshot} from '../src/model.js';

function picture(): ReturnType<typeof buildExportPicture> {
  const snapshot: AtlasSnapshot = {
    root: '/work/multi-agent',
    extractedAt: '2026-09-26T00:00:00.000Z',
    kind: 'source',
    nodes: [
      {
        id: 'types',
        version: '0.0.0',
        private: true,
        path: 'src/types',
        description: '',
        files: ['A.ts'],
      },
      {id: 'a&b', version: '1.2.0', private: false, path: 'src/a', description: ''},
    ],
    edges: [
      {id: atlasEdgeId('imports', 'types', 'a&b'), from: 'types', to: 'a&b', relation: 'imports'},
      {
        id: atlasEdgeId('bundle-includes', 'types', 'a&b'),
        from: 'types',
        to: 'a&b',
        relation: 'bundle-includes',
      },
    ],
  };
  const layout: AtlasLayout = {
    width: 640,
    height: 240,
    frameWidth: 640,
    frameHeight: 240,
    ranks: [
      {index: 0, ids: ['types'], x: 0, width: 280},
      {index: 1, ids: ['a&b'], x: 320, width: 320},
    ],
    nodes: [
      {id: 'types', rank: 0, x: 32, y: 80, width: 184, height: 54, cyclic: false},
      {id: 'a&b', rank: 1, x: 360, y: 80, width: 184, height: 54, cyclic: false},
    ],
    edges: snapshot.edges.map((edge) => ({...edge, cyclic: false})),
  };

  return buildExportPicture({
    root: snapshot.root,
    lens: 'impact',
    snapshot,
    layout,
    emphasis: {nodes: ['types', 'a&b'], edges: [atlasEdgeId('imports', 'types', 'a&b')]},
    selectedId: 'types',
    filter: '',
  });
}

test('draw.io export keeps nodes, relations, and escaped labels', () => {
  const xml = toDrawio(picture());

  assert(xml.includes('<mxfile host="grafyx-atlas"'), 'the file is a diagrams.net document');
  assert(xml.includes('name="multi-agent impact"'), 'the diagram is named from the root and lens');
  assert(xml.includes('background="#12110e"'), 'the page keeps the field color');
  assert(xml.includes('a&amp;b'), 'labels escape markup');
  assert(xml.includes('source="n0" target="n1"'), 'the edge connects the placed nodes');
  assert(xml.includes('strokeColor=#b08972'), 'bundle-includes stays copper-gray');
  assert(xml.includes('dashed=1;dashPattern=4 5;opacity=15;'), 'a quiet bundle edge is dashed');
  assert(xml.includes('strokeColor=#e07a45'), 'the selected node keeps the copper edge');
  assert(xml.includes('1 file&lt;/span'), 'a folder shows its file count');
  assert(xml.includes('shape=mxgraph.basic.folder'), 'a folder keeps a folder shape');
  assert(xml.includes('shape=mxgraph.basic.folded_corner'), 'a file keeps a folded corner');
  assert(xml.includes('fillColor=#3a3128'), 'a folder stays in the warm field palette');
  assert(xml.includes('fillColor=#1c2124'), 'a file stays in the warm field palette');
});

test('a loose source file is not drawn as a folder', () => {
  const file = {
    id: 'index.ts',
    version: '',
    private: false,
    path: 'src/index.ts',
    description: '',
    files: ['index.ts'],
  };
  const folder = {
    id: 'agents',
    version: '',
    private: false,
    path: 'src/agents',
    description: '',
    files: ['Agent.ts'],
  };

  assert(nodeShape('source', file) === 'file', 'a file that lists itself stays a file');
  assert(nodeShape('source', folder) === 'folder', 'a folder lists the files inside it');
  assert(nodeShape('workspace', folder) === null, 'a package map has no folder shape');
  assert(nodeCaption(file, 'file') === 'file', 'a file is captioned as a file');
  assert(nodeCaption(folder, 'folder') === '1 file', 'a folder is captioned with its count');
});

test('a jpeg becomes a one-page pdf', () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0xd9]);
  const pdf = jpegToPdf(jpeg, 200, 100, 100, 50);
  const text = new TextDecoder().decode(pdf);

  assert(text.startsWith('%PDF-1.4'), 'the file is a PDF');
  assert(text.includes('/Filter /DCTDecode'), 'the page image is a JPEG');
  assert(text.includes('/Width 200 /Height 100'), 'the image keeps its pixel size');
  assert(text.includes('/MediaBox [0 0 100 50]'), 'the page matches the picture');
  assert(text.trimEnd().endsWith('%%EOF'), 'the file is closed');

  const start = Number(text.match(/startxref\n(\d+)/)?.[1]);
  assert(text.slice(start, start + 4) === 'xref', 'startxref points at the table');
  assert(pdf.includes(0xff) && pdf.includes(0xd8), 'the JPEG bytes are embedded');
});

test('export names come from the project and the lens', () => {
  assert(
    exportFilename('/Users/me/multi-agent-typescript', 'map', 'drawio') ===
      'multi-agent-typescript-map.drawio',
    'the project name leads the file',
  );
  assert(
    exportFilename('/', 'order', 'pdf') === 'atlas-order.pdf',
    'an empty root still names a file',
  );
});
