import type { IncomingMessage, ServerResponse } from "node:http";
import { HEADERS } from "@clevix/protocol";
import { serve as serveFetch, type ServeOptions } from "./serve.ts";

// Express adapter: `app.use("/api/flow", serve({ client, functions }))`.
// Settings are read from process.env.
//
// The signature is checked over the raw body bytes, so this middleware needs the
// body as it came. It reads the stream itself when nothing read it before. It also
// takes a body left as bytes or text by `express.raw()` or `express.text()`. A body
// already parsed by `express.json()` cannot be turned back into the same bytes, so
// a POST like that gets a 500 that says what to change.

export type { ServeOptions };

/** The parts of Express's request this adapter uses (Express 5). */
export interface ExpressRequest extends IncomingMessage {
  body?: unknown;
  /** "http" or "https". Follows X-Forwarded-Proto only when `trust proxy` is set. */
  protocol: string;
  /** Host and port. Follows X-Forwarded-Host only when `trust proxy` is set. */
  host?: string;
  originalUrl: string;
}

export type Middleware = (req: ExpressRequest, res: ServerResponse, next: (err?: unknown) => void) => Promise<void>;

export function serve(options: ServeOptions): Middleware {
  const handler = serveFetch(options);
  return async (req, res, next) => {
    try {
      const method = req.method ?? "GET";
      const body = await rawBody(req);
      if (body === null) {
        await send(
          res,
          Response.json(
            {
              name: "BodyAlreadyParsed",
              message:
                "the request body was already parsed (for example by express.json()), so its signature cannot be checked. " +
                'Mount this middleware before express.json(), or put express.raw({ type: "*/*" }) on its path',
            },
            { status: 500 },
          ),
        );
        return;
      }
      const request = new Request(requestUrl(req), {
        method,
        headers: requestHeaders(req),
        ...(method === "GET" || method === "HEAD" ? {} : { body }),
      });
      await send(res, await handler(request));
    } catch (err) {
      // A streamed answer already sent its headers: end the connection, as a lost answer.
      if (res.headersSent) res.destroy(err instanceof Error ? err : new Error(String(err)));
      else next(err);
    }
  };
}

/** The raw body, or null when a parser already turned it into an object. */
async function rawBody(req: ExpressRequest): Promise<Uint8Array<ArrayBuffer> | string | null> {
  if (Buffer.isBuffer(req.body)) return new Uint8Array(req.body);
  if (typeof req.body === "string") return req.body;
  // body-parser sets `_body` once it has read the stream.
  const read = (req as { _body?: boolean })._body === true || req.readableEnded;
  if (!read) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
    return new Uint8Array(Buffer.concat(chunks));
  }
  // Only a POST needs its body; GET is signed over the empty body and PUT has none.
  return req.method === "POST" ? null : "";
}

function requestUrl(req: ExpressRequest): string {
  const host = req.host ?? req.headers.host ?? "localhost";
  return `${req.protocol}://${host}${req.originalUrl}`;
}

function requestHeaders(req: ExpressRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  return headers;
}

/** Sends the answer: a streamed answer chunk by chunk, so its heartbeats go out as they come. */
async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (!response.body || response.headers.get(HEADERS.stream) !== "1") {
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }
  const reader = response.body.getReader();
  // The engine went away: stop reading, which stops a streamed answer's heartbeats.
  const onClose = () => void reader.cancel().catch(() => {});
  if (res.destroyed) onClose();
  res.once("close", onClose);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    res.off("close", onClose);
  }
  res.end();
}
