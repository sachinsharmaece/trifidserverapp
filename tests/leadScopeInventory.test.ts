import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LEAD_SCOPE_EXEMPT } from '../src/shared/scopeRegistry.js';

/**
 * Phase 5 (DEC-060) — every staff GET route either carries a lead-scope
 * middleware (requireInScope / scopeList) or is listed in LEAD_SCOPE_EXEMPT
 * with the reason it names no buyer or seller. Like the wall sweep, routes
 * are discovered from the routers themselves, so a new endpoint fails this
 * test until someone decides which it is.
 */
interface Layer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: { leadScope?: unknown } }>;
  };
}

async function staffGetRoutes(): Promise<Array<{ path: string; scoped: boolean }>> {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.routes.ts')) files.push(full);
    }
  };
  walk(join(process.cwd(), 'src', 'modules'));

  const found = new Map<string, boolean>();
  for (const file of files) {
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      const stack = (exported as { stack?: unknown[] } | undefined)?.stack;
      if (!Array.isArray(stack)) continue;
      for (const layer of stack as Layer[]) {
        const route = layer.route;
        if (!route?.methods.get || !route.path.startsWith('/staff')) continue;
        found.set(
          route.path,
          route.stack.some((l) => l.handle.leadScope !== undefined),
        );
      }
    }
  }
  return [...found].map(([path, scoped]) => ({ path, scoped }));
}

describe('Phase 5 — lead-scope route inventory', () => {
  it('every staff GET route is scoped or exempt with a reason', async () => {
    const routes = await staffGetRoutes();
    expect(routes.length).toBeGreaterThan(50);
    const unclassified = routes
      .filter((r) => !r.scoped && !(r.path in LEAD_SCOPE_EXEMPT))
      .map((r) => r.path);
    expect(unclassified).toEqual([]);
  });

  it('nothing is both scoped and exempt, and every exemption still exists', async () => {
    const routes = await staffGetRoutes();
    const paths = new Set(routes.map((r) => r.path));
    const both = routes.filter((r) => r.scoped && r.path in LEAD_SCOPE_EXEMPT).map((r) => r.path);
    expect(both).toEqual([]);
    const stale = Object.keys(LEAD_SCOPE_EXEMPT).filter((p) => !paths.has(p));
    expect(stale).toEqual([]);
    for (const reason of Object.values(LEAD_SCOPE_EXEMPT))
      expect(reason.length).toBeGreaterThan(10);
  });
});
