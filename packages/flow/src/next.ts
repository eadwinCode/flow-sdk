import { serve as serveFetch, type ServeOptions } from "./serve.ts";

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
  const route: RouteHandler = (request) => handler(request);
  return { GET: route, POST: route, PUT: route };
}
