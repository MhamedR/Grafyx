# Grafyx Atlas for VS Code

VS Code commands, diagnostics, and a local map for [grafyx-atlas](../atlas). The extension is the editor adapter. `grafyx-atlas` remains the implementation: parsing, the graph, validation, snapshots, and the map server all run there.

```
VS Code
  │
  ▼
grafyx-atlas-vscode
  │  commands, settings, paths, diagnostics
  ▼
grafyx-atlas
  │  extractProject, lenses, startAtlasServer
  ▼
the project on disk
```

## What you can do

| Command                               | What it calls                                                     |
| ------------------------------------- | ----------------------------------------------------------------- |
| **Grafyx Atlas: Open Map**            | `startAtlasServer` from `grafyx-atlas/server`, then opens the map |
| **Grafyx Atlas: Stop Map**            | Closes the server this extension started                          |
| **Grafyx Atlas: Show Impact**         | `downstream` for the part that contains the file                  |
| **Grafyx Atlas: Show Upstream**       | `upstream` for that part                                          |
| **Grafyx Atlas: Show Cycles**         | `cycles`                                                          |
| **Grafyx Atlas: Show Build Order**    | `order`                                                           |
| **Grafyx Atlas: Show Stats**          | `structureStats`                                                  |
| **Grafyx Atlas: Go Deeper**           | `extractSourceFocus`                                              |
| **Grafyx Atlas: Refresh Diagnostics** | Scans again and republishes cycle warnings                        |
| **Grafyx Atlas: Run Command**         | `parseCommand`, the same `<part> <lens>` box as the map           |

Impact, Upstream, Go Deeper, and Open Map are also on the Explorer context menu. Impact and Upstream are on the editor context menu.

Show Impact and Show Upstream open the map on the part you picked. Impact lights what must be rebuilt. Upstream lights what that part stands on. The same text is written to the **Grafyx Atlas** output channel. A notification is used for errors, for unsaved files, and when the map starts or stops.

Cycle warnings come from `cycles`. Each warning is attached to a file in that part, at the start of the file, because the extractor reports parts and not source positions. The Problems panel uses severity Warning and source `Grafyx Atlas`. There are no code actions: grafyx-atlas does not return edits.

## Installation

From a packaged extension:

```bash
code --install-extension grafyx-atlas-vscode-1.0.0.vsix
```

The extension runs in the workspace extension host (Node.js 20 or newer, VS Code 1.95 or newer).

## Configuration

Settings map onto the CLI. They do not introduce a second scan configuration.

| Setting                   | CLI                                           | Default          |
| ------------------------- | --------------------------------------------- | ---------------- |
| `grafyxAtlas.root`        | `--root`                                      | workspace folder |
| `grafyxAtlas.port`        | edited setting, otherwise `PORT`, then `4328` | `4328`           |
| `grafyxAtlas.openIn`      | editor tab, system browser, or `--no-open`    | `editor`         |
| `grafyxAtlas.diagnostics` | cycle warnings from the same `cycles` call    | `true`           |

`grafyxAtlas.root` empty uses the workspace folder that contains the file you invoked the command on. One open folder is used when there is no file. Several folders ask you to pick. A relative value resolves from that folder. An absolute value is used as written.

The extension does not use `process.cwd()` as the project root. `CI=true` is a CLI switch only; in VS Code, `grafyxAtlas.openIn` decides whether a browser opens.

`grafyxAtlas.port` defaults to `4328`. The grafyx-atlas CLI stays on `4318`, so the editor map and a CLI map can run at the same time. An untouched setting still yields to `PORT`. Once you set the port, that value is used and `PORT` is ignored.

`grafyxAtlas.openIn`:

- `editor` shows the map in a VS Code tab. This is the default.
- `external` opens the system browser, same as the CLI
- `none` leaves the server running and does not open a window (`--no-open`)

## Supported files

The scan is the atlas scan. On a source map it reads `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.mts`, and `.cts`. It skips `.d.ts`, `node_modules`, `dist`, `coverage`, and dot-folders. A workspace whose `package.json` lists more than one package is a package map instead. See the [grafyx-atlas readme](../atlas/README.md) for the full rules.

## Development

From the repository root:

```bash
npm ci
npm run build:vscode
```

`build:vscode` builds grafyx, builds grafyx-atlas (library, CLI, and the prebuilt map UI), then bundles this package to `dist/extension.js` and copies the map UI beside it.

Launch **Grafyx Atlas** from the Run and Debug view. That runs the Extension Development Host with `--extensionDevelopmentPath` pointed at this package. The pre-launch task is `build:vscode`.

Extension tests use the Node test runner and call grafyx-atlas directly. They do not download VS Code.

```bash
npm test
npm run test -w grafyx-atlas-vscode
```

`npm test` builds grafyx and grafyx-atlas first, then runs this package's tests with the rest of the suite. The grafyx-atlas tests are unchanged.

Typecheck:

```bash
npm run typecheck
```

## Packaging

```bash
npm run package -w grafyx-atlas-vscode
```

That builds the bundle and writes `grafyx-atlas-vscode-1.0.0.vsix` in this directory. The vsix contains the bundled adapter and the prebuilt map UI. It does not carry a second copy of the grafyx-atlas source.

## Limitations

- The scan reads the filesystem. Unsaved editor buffers are not part of the snapshot. The command warns you and still scans the saved copy. An untitled document has to be saved first.
- Diagnostics update when you run an atlas command, not on each keystroke.
- Cycle warnings are file-level. grafyx-atlas does not report the line of an import.
- Draw.io, PDF, and JPEG export stay in the map UI. Open Map and use **export** there.
- The server listens on `127.0.0.1` only, same as the CLI.
- A file outside the open workspace is scanned from the nearest parent `package.json`. An absolute `grafyxAtlas.root` overrides that.

## Troubleshooting

**Build grafyx before starting atlas.** The CLI prints this when the UI is not prebuilt. `npm run build:vscode` builds grafyx and the prebuilt UI.

**Port already in use.** Another process, or a map you already started, has `grafyxAtlas.port`. Stop Map, or choose another port.

**Open a folder to map a project.** The command had no workspace folder and no file to walk from.

**grafyxAtlas.root is relative.** A relative root needs a workspace folder. The working directory is not a substitute.

**Nothing deeper here.** `extractSourceFocus` returned null, the same result as the map server's 404.

**The map is blank or shows a read error.** The page still loads; the boot payload carries the atlas error. The output channel has the same message.
