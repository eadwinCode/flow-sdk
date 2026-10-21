// Streamed answers (SDK v0.6.0 and later; see docs/protocol.md, "Streamed answers").
//
// A proxy in front of the app (Cloudflare: 100 s, nginx: 60 s) ends a call that sends
// nothing for too long. When the engine asks for it (request header X-Flow-Stream: 1),
// the app answers 200 at once with X-Flow-Stream: 1, sends a "\n" heartbeat now and
// then, and at the end sends one meta line and the answer's raw body:
//
//   \n\n\n{"status":206,"noRetry":null,"retryAfter":null,"signature":"s=…"}\n<body>
//
// The meta line carries what a normal answer has in its status and headers. The
// signature is the same X-Flow-Answer-Signature value over the same parts.

import { HEADERS } from "./types.ts";

/** One heartbeat. Only "\n" counts as a heartbeat. */
export const STREAM_HEARTBEAT = "\n";

/** Time between heartbeats when the app does not say. Well under nginx's 60 s. */
export const DEFAULT_HEARTBEAT_MS = 20_000;

/** The headers of a streamed answer (status 200). They ask proxies not to hold the bytes back. */
export const STREAM_ANSWER_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store, no-transform",
  "X-Accel-Buffering": "no",
  [HEADERS.stream]: "1",
};

/** What a streamed answer carries: a normal answer's status, retry headers, signature and body. */
export interface StreamedAnswer {
  status: number;
  /** X-Inngest-No-Retry, or null. */
  noRetry: string | null;
  /** Retry-After, or null. */
  retryAfter: string | null;
  /** X-Flow-Answer-Signature, or null when the answer is not signed (dev mode). */
  signature: string | null;
  /** The raw body, as a normal answer would have sent it. */
  body: string;
}

/** The end of a streamed answer, after the heartbeats: the meta line, then the raw body. */
export function streamedAnswerTail(a: StreamedAnswer): string {
  const meta = { status: a.status, noRetry: a.noRetry, retryAfter: a.retryAfter, signature: a.signature };
  return `${JSON.stringify(meta)}\n${a.body}`;
}

/** Reads a whole streamed answer (heartbeats, meta line, body). Throws when it is not one. */
export function parseStreamedAnswer(text: string): StreamedAnswer {
  let start = 0;
  while (text.startsWith(STREAM_HEARTBEAT, start)) start += STREAM_HEARTBEAT.length;
  const end = text.indexOf("\n", start);
  if (end === -1) throw new Error("the streamed answer has no meta line");
  let meta: unknown;
  try {
    meta = JSON.parse(text.slice(start, end));
  } catch {
    throw new Error("the streamed answer's meta line is not JSON");
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error("the streamed answer's meta line is not an object");
  }
  const m = meta as Record<string, unknown>;
  if (typeof m.status !== "number" || !Number.isInteger(m.status) || m.status < 100 || m.status > 599) {
    throw new Error("the streamed answer's meta line has a bad status");
  }
  const field = (name: string): string | null => {
    const v = m[name];
    if (v === null || v === undefined) return null;
    if (typeof v !== "string") throw new Error(`the streamed answer's meta line has a bad ${name}`);
    return v;
  };
  return {
    status: m.status,
    noRetry: field("noRetry"),
    retryAfter: field("retryAfter"),
    signature: field("signature"),
    body: text.slice(end + 1),
  };
}
