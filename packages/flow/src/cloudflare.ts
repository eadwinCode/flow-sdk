import { serve as serveFetch, type ServeOptions, type WaitUntil } from "./serve.ts";

// Workers adapter: `export default serve({ client, functions })`.
// The Worker's `env` is passed through, so FLOW_* vars and secrets are read from it.
// The sync at boot runs on an isolate's first request, in `ctx.waitUntil`, so it
// never slows the answer.

export type { ServeOptions };

export function serve(options: ServeOptions): { fetch(request: Request, env?: unknown, ctx?: WaitUntil): Promise<Response> } {
  const handler = serveFetch(options);
  return { fetch: (request, env, ctx) => handler(request, env, ctx) };
}
