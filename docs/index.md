---
layout: home

hero:
  name: Clevix Flow
  text: Background work that does not get lost
  tagline: >-
    Clevix Flow runs functions for your app. A function is made of steps. The engine
    saves the result of each step, tries a failed step again, and can pause a
    function for seconds or for months.
  actions:
    - theme: brand
      text: Start here
      link: /what-is-clevix-flow
    - theme: alt
      text: Quick start
      link: /getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/eadwinCode/flow-sdk

features:
  - title: Background jobs
    details: >-
      Move slow work out of a web request. Your route answers at once. The work runs
      later, with retries, at a pace an outside API can take.
    link: /background-jobs
    linkText: Read the guide
  - title: Webhooks and events
    details: >-
      Take webhooks from GitHub, Stripe or any other service, check them, and handle
      each one once, even when the sender sends it twice.
    link: /webhooks
    linkText: Read the guide
  - title: Crons and scheduled jobs
    details: >-
      Run code on a timetable, in the time zone you pick. Run it once at a set time,
      or wait days between two steps.
    link: /crons
    linkText: Read the guide
---

## Who it is for

Clevix Flow is for developers who build a web app or an API in **TypeScript** or
**Go**, and have work that must not get lost: the emails after a sign-up, a payment
webhook, a report every night.

You add the SDK to your app and write functions in your own code. The hosted engine
runs them, and you see every run in the
[dashboard](https://dashboard.flow.clevixstudio.com).

New here? Read [What is Clevix Flow](what-is-clevix-flow.md) and
[Core ideas](core-ideas.md), then do the [Quick start](getting-started.md).
