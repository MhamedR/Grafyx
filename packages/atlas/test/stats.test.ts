import {test} from 'node:test';
import {assert} from '../../../test/assert.js';
import {
  atlasEdgeId,
  formatBytes,
  nodeCaption,
  type AtlasSnapshot,
  type PackageNode,
} from '../src/model.js';
import {structureStats} from '../src/stats.js';

test('structure stats rank weight, reach, and coupling', () => {
  const snapshot: AtlasSnapshot = {
    root: '/app',
    extractedAt: '2026-09-28T00:00:00.000Z',
    kind: 'source',
    scan: {durationMs: 12, fileCount: 3, byteCount: 610, lineCount: 25},
    nodes: [
      {
        id: 'a.ts',
        version: '',
        private: false,
        path: 'a.ts',
        description: '',
        files: ['a.ts'],
        measures: [{path: 'a.ts', bytes: 100, lines: 4}],
      },
      {
        id: 'lib',
        version: '',
        private: false,
        path: 'lib',
        description: '',
        files: ['big.ts', 'small.ts'],
        measures: [
          {path: 'big.ts', bytes: 500, lines: 20},
          {path: 'small.ts', bytes: 10, lines: 1},
        ],
      },
    ],
    edges: [
      {
        id: atlasEdgeId('imports', 'a.ts', 'lib'),
        from: 'a.ts',
        to: 'lib',
        relation: 'imports',
      },
    ],
  };

  const stats = structureStats(snapshot);

  assert(stats.largestFiles[0]?.path === 'lib/big.ts', 'the heaviest file leads');
  assert(stats.largestFiles[0]?.bytes === 500, 'file bytes are kept');
  assert(stats.largestFiles[1]?.path === 'a.ts', 'a file node is not prefixed with itself');
  assert(stats.weight[0]?.id === 'lib', 'the folder outweighs the loose file');
  assert(stats.weight[0]?.bytes === 510, 'folder bytes are the sum of its files');
  assert(
    stats.blast[0]?.id === 'a.ts' && stats.blast[0].reached === 1,
    'a change in a.ts reaches lib',
  );
  assert(
    stats.coupling.some((item) => item.id === 'lib' && item.inDegree === 1 && item.outDegree === 0),
    'lib stands on one part',
  );
  assert(stats.scan?.durationMs === 12, 'scan timing is passed through');
  assert(stats.totals.files === 3, 'totals count measured files');
  assert(formatBytes(1536) === '1.5 KB', 'sizes under 10 KB keep one decimal');
  assert(formatBytes(20 * 1024) === '20 KB', 'sizes from 10 KB are whole numbers');
  assert(formatBytes(0) === '0 B', 'an empty file is zero bytes');
  assert(formatBytes(Number.NaN) === '0 B', 'a non-finite size is zero bytes');
  assert(formatBytes(12) === '12 B', 'bytes stay in bytes under 1 KB');
  assert(formatBytes(1.5 * 1024 * 1024) === '1.5 MB', 'megabytes keep one decimal under 10');
  assert(formatBytes(1024 * 1024 * 1024) === '1 GB', 'a gibibyte is reported in GB');
});

test('structure stats omit empty parts and break ties on the label', () => {
  const files = Array.from({length: 9}, (_, index) => ({
    path: `f${index}.ts`,
    bytes: 90 - index * 10,
    lines: 1,
  }));
  const heavy: PackageNode = {
    id: 'heavy',
    version: '1.0.0',
    private: false,
    path: 'heavy',
    description: '',
    files,
    measures: [...files, {path: 'heavy/already.ts', bytes: 100, lines: 1}],
  };
  const tied: PackageNode = {
    id: 'tied',
    version: '',
    private: false,
    path: 'tied',
    description: '',
    measures: [{path: 'tied', bytes: 40, lines: 1}],
  };
  const same: PackageNode = {
    id: 'same',
    version: '',
    private: false,
    path: 'same',
    description: '',
    measures: [{path: 'same', bytes: 40, lines: 1}],
  };
  const empty: PackageNode = {
    id: 'empty',
    version: '0.0.0',
    private: false,
    path: 'empty',
    description: '',
  };
  const zero: PackageNode = {
    id: 'zero',
    version: '',
    private: false,
    path: 'zero',
    description: '',
    measures: [{path: 'zero', bytes: 0, lines: 0}],
  };
  const snapshot: AtlasSnapshot = {
    root: '/app',
    extractedAt: '2026-09-28T00:00:00.000Z',
    kind: 'source',
    nodes: [heavy, tied, same, empty, zero],
    edges: [
      {id: 'imports:heavy:tied', from: 'heavy', to: 'tied', relation: 'imports'},
      {id: 'imports:heavy:same', from: 'heavy', to: 'same', relation: 'imports'},
    ],
  };

  const stats = structureStats(snapshot);

  assert(stats.largestFiles.length === 8, 'the chart keeps the eight heaviest files');
  assert(
    stats.largestFiles.some((file) => file.path === 'heavy/already.ts'),
    'a prefixed path stays',
  );
  assert(stats.weight[1]?.id === 'same', 'equal weights sort by name');
  assert(stats.blast[0]?.id === 'heavy' && stats.blast[0].reached === 2, 'heavy reaches both ties');
  assert(!stats.blast.some((item) => item.id === 'empty'), 'an isolated part has no reach');
  assert(
    !stats.coupling.some((item) => item.id === 'zero'),
    'a part with no edges is not coupling',
  );
  assert(stats.scan === null, 'a snapshot without a scan has no scan cost');
  assert(
    nodeCaption(heavy, 'folder') === '9 files · 550 B',
    'a folder caption includes its weight',
  );
  assert(nodeCaption(tied, 'file') === '40 B', 'a measured file shows its size');
  assert(nodeCaption(heavy, null) === '1.0.0 · 550 B', 'a package caption keeps its version');
  assert(nodeCaption(empty, null) === '0.0.0', 'a package without measures shows its version');
});
