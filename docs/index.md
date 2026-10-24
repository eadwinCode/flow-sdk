---
layout: home

hero:
  name: flow-sdk
  text: Durable functions made of steps
  tagline: >-
    The TypeScript and Go SDKs for the Clevix Flow engine. Your app defines
    functions. Events start them. The engine runs them one step at a time,
    saves each step's result, and tries a failed step again.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Functions and steps
      link: /functions
    - theme: alt
      text: GitHub
      link: https://github.com/eadwinCode/flow-sdk

features:
  - title: Steps run once
    details: >-
      The engine saves the result of each step. If a step fails, only that step
      is tried again. Code with a side effect, like an email or a payment, goes
      in a step.
  - title: Runs can wait for days
    details: >-
      Sleep for a time, sleep until a date, or wait for another event, with a
      timeout in case it never comes.
  - title: Events and schedules
    details: >-
      Events start runs, sent from your app, from a function, or over HTTP. Cron
      triggers run on a timetable, in the time zone you pick.
  - title: Flow control
    details: >-
      Concurrency, throttle, rate limit, debounce, batching, priority,
      idempotency and singleton. Set them on the function; the engine does the
      rest.
  - title: Live progress in the browser
    details: >-
      Publish small messages from a function and show them on the page over a
      WebSocket, with a React hook if you want one.
  - title: TypeScript and Go, one protocol
    details: >-
      Both SDKs speak the same protocol, so a TypeScript function can invoke a Go
      function. Adapters for Cloudflare Workers, Hono, Next.js and Express. The Go
      SDK uses the standard library only.
---
