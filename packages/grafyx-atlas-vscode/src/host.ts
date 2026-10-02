import type {AtlasSnapshot} from 'grafyx-atlas';
import type {AtlasFileDiagnostic} from './diagnostics.js';

/**
 * The slice of VS Code the controller needs.
 * Tests pass a fake. The extension host is wired in `vscode-adapter.ts`.
 */
export interface AtlasHost {
  registerCommand(id: string, handler: (argument: unknown) => Promise<void>): void;
  log(message: string): void;
  showError(message: string): void;
  showWarning(message: string): void;
  showInformation(message: string): void;
  pick(items: readonly string[], placeHolder: string): Promise<string | undefined>;
  input(prompt: string, placeHolder: string): Promise<string | undefined>;
  openExternal(url: string): Promise<void>;
  openInEditor(url: string): Promise<void>;
  setDiagnostics(diagnostics: readonly AtlasFileDiagnostic[]): void;
  clearDiagnostics(): void;
  revealOutput(): void;
  /** Last scan, for the Architecture view. */
  setStructure(snapshot: AtlasSnapshot | null): void;
}
