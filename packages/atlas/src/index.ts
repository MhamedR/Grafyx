/**
 * Public atlas API. The dev server and the picture stay behind their own
 * entry points so a library import does not start a browser bundle.
 */

export {
  BUNDLE_INCLUDES,
  CYCLE_CLEAR,
  DIRECTION_LINE,
  EMPTY_LINE,
  LENSES,
  LENS_QUESTION,
  IMPORTS,
  READING_LINE,
  SOURCE_LENS_QUESTION,
  WORKSPACE_DEPENDS,
  atlasEdgeId,
  isLens,
  formatBytes,
  nodeBytes,
  nodeShape,
  type AtlasBoot,
  type AtlasEdge,
  type AtlasSnapshot,
  type FileMeasure,
  type Lens,
  type PackageNode,
  type Relation,
  type ScanStats,
  type Viewport,
} from './model.js';

export {extractProject} from './extract-project.js';
export {extractSource, extractSourceFocus} from './extract-source.js';
export {extractWorkspace} from './extract-workspace.js';

export {
  buildPackageGraph,
  components,
  cycles,
  degrees,
  downstream,
  order,
  path,
  relationOf,
  upstream,
  type BuildOrder,
  type Degrees,
  type PackageGraph,
} from './structural.js';

export {diffSnapshots, type AtlasDiff, type NodeChange} from './diff.js';

export {
  structureStats,
  type BlastRadius,
  type Coupling,
  type LargestFile,
  type PartWeight,
  type StructureStats,
} from './stats.js';

export {
  applyOffsets,
  labelWidth,
  layoutSnapshot,
  type AtlasLayout,
  type NodeOffset,
  type PlacedEdge,
  type PlacedNode,
  type RankBand,
} from './layout.js';

export {
  connectAtlasSession,
  createAtlasSession,
  parseCommand,
  type AtlasConnection,
  type AtlasSession,
  type Emphasis,
} from './session.js';

export {
  FOCUS_LABEL,
  FOCUS_MODES,
  directRelations,
  locateByPath,
  matchesQuery,
  presentEdge,
  presentNode,
  searchNodes,
  visibleIds,
  type DirectRelations,
  type EdgeFlow,
  type FocusMode,
  type NodeRole,
  type SearchHit,
} from './explore.js';
