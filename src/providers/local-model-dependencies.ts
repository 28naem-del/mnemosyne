import { closeSync, openSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';

const guidance = 'Local CPU models require stable sharp >=0.35.4 as resolved by @huggingface/transformers. '
  + 'In the consumer root package.json, pin the direct dependency to "@huggingface/transformers":"3.8.1" and add {"overrides":{"@huggingface/transformers@3.8.1":{"sharp":"0.35.4"}}}, '
  + 'then reinstall dependencies explicitly. See docs/LOCAL-MODELS.md.';

function readManifest(path: string): Record<string, unknown> | undefined {
  let descriptor: number;
  try { descriptor = openSync(path, 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const bytes = Buffer.alloc(65_537);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(descriptor, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > 65_536) throw new Error();
    const value: unknown = JSON.parse(bytes.toString('utf8', 0, size));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } finally { closeSync(descriptor); }
}

function sharpManifest(runtimeEntry: string): Record<string, unknown> {
  // Sharp exposes its executable entry, but patched releases hide package.json
  // behind exports. Resolve the dependency without executing it, then inspect
  // its owning package. Never substitute another root/ancestor dependency copy.
  let directory = dirname(createRequire(runtimeEntry).resolve('sharp'));
  for (let depth = 0; depth < 16; depth++) {
    if (basename(directory) === 'node_modules') break;
    const metadata = readManifest(join(directory, 'package.json'));
    if (metadata?.name !== undefined) {
      if (metadata.name !== 'sharp') throw new Error();
      return metadata;
    }
    // A dist/package.json may only declare module type, with no package name.
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error();
}

/** Enforces the minimum fix for a known transitive dependency advisory. This
 * is not a general safety guarantee for every later package version. Checking
 * metadata must happen before importing the optional native runtime. */
export function assertLocalModelDependencies(runtimeEntry: string): void {
  try {
    // Resolve relative to the exact ESM entry that the worker will import. A
    // patched, unrelated copy at the application root cannot mask a nested one.
    const version = sharpManifest(runtimeEntry).version;
    if (typeof version !== 'string' || version.length > 128) throw new Error();
    // Stable SemVer only: prereleases do not satisfy the known patched floor.
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
    if (!match) throw new Error();
    const [major, minor, patch] = match.slice(1, 4).map(Number);
    if (![major, minor, patch].every(Number.isSafeInteger)
      || !(major > 0 || (major === 0 && (minor > 35 || (minor === 35 && patch >= 4))))) throw new Error();
  } catch {
    // Resolution/parser errors may contain installation paths or manifest text.
    throw new Error(guidance);
  }
}
