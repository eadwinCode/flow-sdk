import { serve as serveFetch, type ServeOptions, type WaitUntil } from "./serve.ts";

// Next.js App Router adapter. In app/api/flow/route.ts:
//   export const { GET, POST, PUT } = serve({ client, functions });
// Settings are read from process.env. The sync at boot runs on the first request,
// in the background, not when the module loads: `next build` loads route modules too,
// and must not sync a manifest before the deploy.

export type { ServeOptions };

/** A route handler. Next passes a second argument (the route params); it is not used. */
export type RouteHandler = (request: Request, context?: unknown) => Promise<Response>;

export function serve(options: ServeOptions): { GET: RouteHandler; POST: RouteHandler; PUT: RouteHandler } {
  const handler = serveFetch(options);
  const route: RouteHandler = (request) => handler(request, undefined, requestContext());
  return { GET: route, POST: route, PUT: route };
}

/**
 * The host's `waitUntil` for this request, when it has one (Vercel puts it on this
 * global), so a serverless host does not freeze the sync check half done. Elsewhere
 * (a Node server) undefined: the check runs in the background with a timer.
 */
function requestContext(): WaitUntil | undefined {
  const holder = (globalThis as Record<symbol, unknown>)[Symbol.for("@vercel/request-context")] as
    | { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined }
    | undefined;
  const ctx = holder?.get?.();
  return typeof ctx?.waitUntil === "function" ? { waitUntil: (p) => ctx.waitUntil!(p) } : undefined;
}
