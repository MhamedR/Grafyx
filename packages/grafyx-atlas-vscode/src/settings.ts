/** VS Code settings mapped onto the grafyx-atlas CLI. */

/** The editor listens here. The grafyx-atlas CLI stays on 4318 so both can run. */
export const DEFAULT_PORT = 4328;

export type AtlasOpenIn = 'external' | 'editor' | 'none';

export interface AtlasSettings {
  /** Empty means the workspace folder, the same default as `--root` and the working directory. */
  readonly root: string;
  readonly port: number;
  /** True when the user set `grafyxAtlas.port`. False means "use PORT, then 4328". */
  readonly portExplicit: boolean;
  readonly openIn: AtlasOpenIn;
  readonly diagnostics: boolean;
}

export function normalizeOpenIn(value: string | undefined): AtlasOpenIn {
  if (value === 'simpleBrowser') return 'editor';
  if (value === 'editor' || value === 'none' || value === 'external') return value;
  return 'editor';
}

/**
 * An edited setting wins, otherwise `PORT`, otherwise 4328.
 * Non-integers are rejected here so a bad setting cannot crash the extension host.
 */
export function resolvePort(
  settings: {readonly port: number; readonly portExplicit: boolean},
  envPort: string | undefined,
): number {
  if (settings.portExplicit) return validPort(settings.port, String(settings.port));
  if (envPort !== undefined && envPort.trim() !== '')
    return validPort(Number(envPort), envPort.trim());
  return validPort(settings.port, String(settings.port));
}

function validPort(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`Port must be an integer from 0 to 65535. Received ${label}.`);
  }
  return value;
}
