/**
 * Hosts the atlas map by calling `startAtlasServer` from grafyx-atlas.
 * `moduleDirectory` is the folder that contains `ui/app.js` and `ui/atlas.css`.
 */

import {startAtlasServer, type RunningAtlasServer} from 'grafyx-atlas/server';

export interface MapServer {
  start(root: string, port: number): Promise<{readonly url: string}>;
  stop(): Promise<boolean>;
}

export function createMapServer(moduleDirectory: string): MapServer {
  let running: RunningAtlasServer | undefined;
  let currentRoot: string | undefined;
  let currentPort: number | undefined;

  return {
    async start(root, port) {
      if (running && currentRoot === root && currentPort === port) return {url: running.url};
      if (running) {
        await running.close();
        running = undefined;
      }
      const started = await startAtlasServer({root, port, moduleDirectory});
      running = started;
      currentRoot = root;
      currentPort = port;
      return {url: started.url};
    },
    async stop() {
      if (!running) return false;
      await running.close();
      running = undefined;
      currentRoot = undefined;
      currentPort = undefined;
      return true;
    },
  };
}
