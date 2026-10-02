# grafyx-atlas

## 2.0.0

### Major Changes

- Make the map explorable. Selecting a node shows its dependencies and dependents and quiets the rest. Search, filter, and focus narrow a large graph, and the VS Code host follows the active file and opens the matching source.

## 1.2.0

### Minor Changes

- Speak MCP on stdio (`grafyx-atlas --mcp`) and export the same read-only tools from `grafyx-atlas/mcp`, so an agent can query the map, impact, upstream, cycles, order, stats, and go deeper without opening the web UI.

## 1.1.0

### Minor Changes

- Zoom from the header, with the current scale, instead of controls drawn on the map. The path beside the title follows the selection, shortens with an ellipsis when it is long, and copies to the clipboard. The order strip can be resized and hidden, long file lists collapse to a count, and tooltips wait before they open.
- 5a6308e: Export `startAtlasServer` from `grafyx-atlas/server` so an editor can host the map without spawning the CLI. Importing the entry does not listen.

## 1.0.0

### Major Changes

- e007837: Add a stats view for the project Atlas scans. The snapshot now carries byte and line counts, and the map can show the heaviest files, the weight of each part, how far a change reaches, how the parts couple, and what the scan cost.

## 0.1.1

### Patch Changes

- Point the published repository and homepage metadata at `MhamedR/Grafyx`.

## 0.1.0

### Minor Changes

- 7a54304: Add grafyx/atlas, a reactive map of a workspace's build order.
