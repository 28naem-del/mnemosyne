import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Resolving a competitor SDK that is deliberately not a dependency.
 *
 * A memory library must not make its competitors' SDKs a dependency of itself:
 * `npm i mnemosy-ai` would then drag in Mem0 and everything Mem0 drags in, and
 * every contributor's `npm ci` would pay for a benchmark that runs occasionally.
 * So the matched run installs them into their own self-contained package under
 * `benchmarks/competitors/`, with its own lockfile, and resolves them from there.
 *
 * That directory is outside Node's resolution path for this module, so the
 * lookup is done explicitly rather than by bare specifier: find the package
 * directory, read its manifest, and honour its own `exports` map to pick the
 * ESM entry point. Nothing is guessed — a missing package, a missing subpath or
 * a manifest without an ESM entry each produce a reason string that ends up in
 * the published table where that system's score would have been.
 */
export type ModuleResolution =
  | { resolved: true; url: string; version: string; directory: string }
  | { resolved: false; reason: string };

interface Manifest { version?: string; main?: string; module?: string; exports?: unknown }

/** Walks one `exports` entry, preferring ESM, then the generic default. */
function entryPoint(value: unknown, depth = 0): string | undefined {
  if (depth > 8) return undefined;
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const conditions = value as Record<string, unknown>;
  for (const key of ['import', 'module', 'default', 'require', 'node']) {
    if (key in conditions) { const found = entryPoint(conditions[key], depth + 1); if (found) return found; }
  }
  return undefined;
}

/**
 * @param baseDir directory holding the `node_modules` the competitor lives in
 * @param packageName the npm package, e.g. `mem0ai`
 * @param subpath the exports subpath, e.g. `./oss`, or `.` for the root
 */
export function resolveCompetitorModule(baseDir: string, packageName: string, subpath = '.'): ModuleResolution {
  if (!/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(packageName)) return { resolved: false, reason: 'Invalid competitor package name.' };
  const root = resolve(baseDir);
  const directory = join(root, 'node_modules', packageName);
  const manifestPath = join(directory, 'package.json');
  if (!existsSync(manifestPath)) {
    return { resolved: false, reason: `${packageName} is not installed under ${join(root, 'node_modules')}. `
      + 'Run `npm run benchmark:matched:install` to install the pinned competitor SDKs.' };
  }
  let manifest: Manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest; }
  catch { return { resolved: false, reason: `${packageName} has an unreadable package.json at ${manifestPath}.` }; }
  const exported = manifest.exports as Record<string, unknown> | string | undefined;
  let relative: string | undefined;
  if (typeof exported === 'string') relative = subpath === '.' ? exported : undefined;
  else if (exported && typeof exported === 'object') relative = entryPoint(exported[subpath]);
  if (!relative && subpath === '.') relative = manifest.module ?? manifest.main;
  if (!relative) return { resolved: false, reason: `${packageName} declares no ESM entry point for "${subpath}"; its installed version may not expose that subpath.` };
  const file = resolve(directory, relative);
  // The entry must stay inside the package it claims to come from.
  const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  if (!isAbsolute(file) || !inside(realpathSync.native(existsSync(file) ? file : directory), realpathSync.native(directory))) {
    return { resolved: false, reason: `${packageName} resolves "${subpath}" outside its own package directory.` };
  }
  if (!existsSync(file)) return { resolved: false, reason: `${packageName} declares "${subpath}" as ${relative}, which does not exist in the installed package.` };
  return { resolved: true, url: pathToFileURL(file).href, version: typeof manifest.version === 'string' ? manifest.version : 'unknown', directory };
}
