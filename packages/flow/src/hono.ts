import type { Context } from "hono";
import { serve as serveFetch, type ServeOptions } from "./serve.ts";

// Hono adapter: `app.on(["GET", "PUT", "POST"], "/api/flow", serve({ client, functions }))`.
// On Workers, `c.env` is passed through, so FLOW_* vars and secrets are read from it.

export type { ServeOptions };

export function serve(options: ServeOptions): (c: Context) => Promise<Response> {
  const handler = serveFetch(options);
  return async (c) => {
    let request = c.req.raw;
    // If a middleware already read the body (for example with `c.req.json()`), Hono keeps
    // the raw text. Rebuild the request from it so the signature check sees the same bytes.
    if (request.bodyUsed) {
      request = new Request(request, { body: await c.req.text() });
    }
    return handler(request, c.env);
  };
}
