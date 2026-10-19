import { serve as serveFetch, type ServeOptions } from "./serve.ts";

// Workers adapter: `export default serve({ client, functions })`.
// The Worker's `env` is passed through, so FLOW_* vars and secrets are read from it.

export type { ServeOptions };

export function serve(options: ServeOptions): { fetch(request: Request, env?: unknown): Promise<Response> } {
  const handler = serveFetch(options);
  return { fetch: (request, env) => handler(request, env) };
}
