import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export async function sourceProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'atlas-vscode-'));
  await mkdir(join(root, 'src/models'), {recursive: true});
  await mkdir(join(root, 'src/services'), {recursive: true});
  await writeFile(join(root, 'package.json'), JSON.stringify({name: 'app', version: '1.0.0'}));
  await writeFile(join(root, 'src/models/user.ts'), 'export interface User { id: string }\n');
  await writeFile(
    join(root, 'src/services/auth.ts'),
    "import type {User} from '../models/user.js';\nexport const current = (): User => ({id: '1'});\n",
  );
  return root;
}

export async function cycleProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'atlas-vscode-cycle-'));
  await mkdir(join(root, 'src/auth'), {recursive: true});
  await mkdir(join(root, 'src/users'), {recursive: true});
  await writeFile(join(root, 'package.json'), JSON.stringify({name: 'loop', version: '1.0.0'}));
  await writeFile(
    join(root, 'src/auth/session.ts'),
    "import {user} from '../users/user.js';\nexport const session = user;\n",
  );
  await writeFile(
    join(root, 'src/users/user.ts'),
    "import {session} from '../auth/session.js';\nexport const user = session;\n",
  );
  return root;
}

export async function remove(root: string): Promise<void> {
  await rm(root, {recursive: true, force: true});
}
