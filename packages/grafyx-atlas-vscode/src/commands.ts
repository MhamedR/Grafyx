/** Command palette entries. Titles are the manifest source of truth. */

export interface AtlasCommand {
  readonly id: string;
  readonly title: string;
}

export const ATLAS_COMMANDS = [
  {id: 'grafyxAtlas.openMap', title: 'Grafyx Atlas: Open Map'},
  {id: 'grafyxAtlas.stopMap', title: 'Grafyx Atlas: Stop Map'},
  {id: 'grafyxAtlas.showImpact', title: 'Grafyx Atlas: Show Impact'},
  {id: 'grafyxAtlas.showUpstream', title: 'Grafyx Atlas: Show Upstream'},
  {id: 'grafyxAtlas.showCycles', title: 'Grafyx Atlas: Show Cycles'},
  {id: 'grafyxAtlas.showOrder', title: 'Grafyx Atlas: Show Build Order'},
  {id: 'grafyxAtlas.showStats', title: 'Grafyx Atlas: Show Stats'},
  {id: 'grafyxAtlas.goDeeper', title: 'Grafyx Atlas: Go Deeper'},
  {id: 'grafyxAtlas.refreshDiagnostics', title: 'Grafyx Atlas: Refresh Diagnostics'},
  {id: 'grafyxAtlas.runCommand', title: 'Grafyx Atlas: Run Command'},
] as const satisfies readonly AtlasCommand[];

export type AtlasCommandId = (typeof ATLAS_COMMANDS)[number]['id'];
