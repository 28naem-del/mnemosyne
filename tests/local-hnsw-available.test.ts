import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `hnswAvailable()` gates every hnsw code path and every `[env:hnsw]` test.
 *
 * `npm ci --ignore-scripts` (the documented contributor install) leaves
 * `hnswlib-node` installed but its native addon unbuilt: the package resolves,
 * yet `require('hnswlib-node')` throws "Could not locate the bindings file".
 * Asking only whether the package *resolves* reported that host as available,
 * so the gated tests ran and crashed instead of skipping countably. The check
 * has to load the addon.
 *
 * `node:module` is mocked so `createRequire()` inside hnsw.ts returns a require
 * whose resolve succeeds while loading throws, exactly like an unbuilt addon.
 */
type Loader = { resolve: (id: string) => string; load: (id: string) => unknown };

async function hnswWith(loader: Loader): Promise<typeof import('../src/local/vector/hnsw.js')> {
  vi.resetModules();
  vi.doMock('node:module', async importOriginal => {
    const actual = await importOriginal<typeof import('node:module')>();
    const createRequire = (from: string | URL): NodeJS.Require => {
      const real = actual.createRequire(from);
      const fake = ((id: string) => (id === 'hnswlib-node' ? loader.load(id) : real(id))) as NodeJS.Require;
      fake.resolve = ((id: string, options?: { paths?: string[] }) => (id === 'hnswlib-node' ? loader.resolve(id) : real.resolve(id, options))) as NodeJS.RequireResolve;
      fake.cache = real.cache;
      return fake;
    };
    return { ...actual, default: { ...actual, createRequire }, createRequire };
  });
  return import('../src/local/vector/hnsw.js');
}

afterEach(() => { vi.doUnmock('node:module'); vi.resetModules(); });

describe('hnswAvailable', () => {
  it('is false when hnswlib-node is installed but its native addon was never built', async () => {
    const { hnswAvailable } = await hnswWith({
      resolve: () => '/fake/node_modules/hnswlib-node/lib/index.js',
      load: () => { throw new Error('Could not locate the bindings file. Tried:\n → /fake/node_modules/hnswlib-node/build/addon.node'); },
    });
    expect(hnswAvailable()).toBe(false);
  });

  it('is false when hnswlib-node is not installed at all', async () => {
    const missing = (): never => { throw Object.assign(new Error("Cannot find module 'hnswlib-node'"), { code: 'MODULE_NOT_FOUND' }); };
    const { hnswAvailable } = await hnswWith({ resolve: missing, load: missing });
    expect(hnswAvailable()).toBe(false);
  });

  it('is true when the addon loads', async () => {
    const { hnswAvailable } = await hnswWith({
      resolve: () => '/fake/node_modules/hnswlib-node/lib/index.js',
      load: () => ({ HierarchicalNSW: class {} }),
    });
    expect(hnswAvailable()).toBe(true);
  });
});
