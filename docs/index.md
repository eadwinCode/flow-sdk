---
layout: home
title: Clevix Flow docs
titleTemplate: false
---

<script setup>
import { withBase } from 'vitepress';

const github = 'https://github.com/eadwinCode/flow-sdk';
const dashboard = 'https://dashboard.flow.clevixstudio.com';

// The four things that happen in a run. The long form is in what-is-clevix-flow.md.
const runSteps = [
  { title: 'Your app sends an event', text: 'A small JSON message, like user/signed-up. The engine saves it and answers at once.' },
  { title: 'The engine starts a run', text: 'It finds every function that this event starts, and makes one run of each.' },
  { title: 'Your app runs one step', text: 'The engine calls your endpoint with a signed POST. Your code runs the next step and answers.' },
  { title: 'The result is saved', text: 'Then the engine calls again for the next step. A failed step is tried again; a done step is not.' },
];

const useCases = [
  {
    title: 'Background jobs',
    text: 'Move slow work out of a web request. Your route answers at once. The work runs later, with retries, at a pace an outside API can take.',
    link: '/background-jobs',
  },
  {
    title: 'Webhooks and events',
    text: 'Take webhooks from GitHub, Stripe or any other service, check them, and handle each one once, even when the sender sends it twice.',
    link: '/webhooks',
  },
  {
    title: 'Crons and scheduled jobs',
    text: 'Run code on a timetable, in the time zone you pick. Run it once at a set time, or wait days between two steps.',
    link: '/crons',
  },
];

// Every page but the use cases (they have their own cards above), with one line on
// each. Keep it in step with the sidebar in .vitepress/config.ts. scripts/check-docs.mjs
// fails the build when a link here names a page that does not exist.
const docsMap = [
  {
    title: 'Start here',
    items: [
      { text: 'What is Clevix Flow', note: 'The moving parts, and how a run happens', link: '/what-is-clevix-flow' },
      { text: 'Core ideas', note: 'Events, functions, steps, runs, replay', link: '/core-ideas' },
      { text: 'Quick start', note: 'From nothing to a finished run', link: '/getting-started' },
      { text: 'Local development', note: 'A local engine, or a tunnel', link: '/local-dev' },
    ],
  },
  {
    title: 'Guides',
    items: [
      { text: 'Functions and steps', note: 'Every kind of step, and triggers', link: '/functions' },
      { text: 'Events', note: 'Send them once, or for later', link: '/events' },
      { text: 'Errors and retries', note: 'Retries, giving up, timeouts', link: '/errors' },
      { text: 'Flow control', note: 'Concurrency, throttle, debounce, batching', link: '/flow-control' },
      { text: 'Realtime', note: 'Live messages to the browser', link: '/realtime' },
      { text: 'Streams', note: 'Kept output a reader can follow', link: '/streams' },
      { text: 'Going to production', note: 'Sync, keys, troubleshooting', link: '/production' },
    ],
  },
  {
    title: 'Reference',
    items: [
      { text: 'TypeScript API', note: '@clevix/flow', link: '/typescript' },
      { text: 'Go API', note: 'github.com/eadwinCode/flow-sdk', link: '/go' },
      { text: 'Settings', note: 'Every env var', link: '/settings' },
      { text: 'HTTP API', note: "The engine's routes and your endpoint", link: '/http-api' },
      { text: 'Limits', note: 'Sizes, counts and times', link: '/limits' },
      { text: 'Protocol', note: 'For SDK authors', link: '/protocol' },
    ],
  },
];
</script>

<div class="fh">
<section class="fh-hero">
<div class="fh-hero-text">
<p class="fh-label">Clevix Flow docs · TypeScript and Go</p>
<h1 class="fh-title">Background work that does not get lost</h1>
<p class="fh-lead">Clevix Flow runs functions for your app. A function is made of steps. The engine saves the result of each step, tries a failed step again, and can pause a function for seconds or for months.</p>
<div class="fh-actions">
<a class="fh-btn brand" :href="withBase('/what-is-clevix-flow')">Start here</a>
<a class="fh-btn" :href="withBase('/getting-started')">Quick start</a>
<a class="fh-btn" :href="github" target="_blank" rel="noreferrer">GitHub</a>
</div>
</div>
<div class="fh-run">
<div class="fh-run-head">
<span class="fh-run-name">hello-world</span>
<span class="fh-badge">Completed</span>
</div>
<p class="fh-run-meta">Started by the event <code>demo/hello</code></p>
<ol class="fh-steps">
<li><span class="fh-step-id">make-greeting</span><span class="fh-step-kind">Step</span><span class="fh-step-note">saved: "Hello, Ada!"</span></li>
<li class="sleep"><span class="fh-step-id">wait-a-moment</span><span class="fh-step-kind">Sleep</span><span class="fh-step-note">10 s, your app is not called</span></li>
<li><span class="fh-step-id">print-greeting</span><span class="fh-step-kind">Step</span><span class="fh-step-note">ran once</span></li>
</ol>
<div class="fh-run-out">
<span class="fh-label">Output</span>
<code v-pre>{"greeting": "Hello, Ada!"}</code>
</div>
</div>
</section>

<section class="fh-section fh-split">
<div>
<p class="fh-label">The SDK</p>
<h2 class="fh-h2">You write a function. It is made of steps.</h2>
<p class="fh-text">The function lives in your own app, next to your database and your secrets. This one makes the run you see above.</p>
<dl class="fh-points">
<div><dt><code>step.run</code></dt><dd>Runs your code and saves the result. A saved step is not run again.</dd></div>
<div><dt><code>step.sleep</code></dt><dd>Pauses the run, for seconds or for months. Nothing runs while it waits.</dd></div>
<div><dt>Retries</dt><dd>When a step fails, the engine waits a little and tries that step again.</dd></div>
</dl>
<p class="fh-more"><a :href="withBase('/functions')">Every kind of step →</a></p>
</div>
<div class="fh-code">

::: code-group
<<< @/../examples/ts/quickstart.ts#function [TypeScript]
<<< @/../examples/go/quickstart/main.go#function [Go]
:::

</div>
</section>

<section class="fh-section">
<p class="fh-label">How it works</p>
<h2 class="fh-h2">The engine calls your app, one step at a time</h2>
<p class="fh-text">Your code never runs inside the engine. Your app serves one endpoint, and the engine calls it.</p>
<ol class="fh-flow">
<li v-for="(s, i) in runSteps" :key="s.title">
<span class="fh-num">0{{ i + 1 }}</span>
<h3>{{ s.title }}</h3>
<p>{{ s.text }}</p>
</li>
</ol>
<p class="fh-more"><a :href="withBase('/what-is-clevix-flow')">What is Clevix Flow →</a></p>
</section>

<section class="fh-section">
<p class="fh-label">Use cases</p>
<h2 class="fh-h2">What people build with it</h2>
<div class="fh-cards">
<a v-for="c in useCases" :key="c.link" class="fh-card" :href="withBase(c.link)">
<h3>{{ c.title }}</h3>
<p>{{ c.text }}</p>
<span class="fh-card-go">Read the guide →</span>
</a>
</div>
</section>

<section class="fh-section">
<p class="fh-label">All the docs</p>
<h2 class="fh-h2">Find your page</h2>
<div class="fh-map">
<div v-for="group in docsMap" :key="group.title">
<h3>{{ group.title }}</h3>
<ul>
<li v-for="item in group.items" :key="item.link">
<a :href="withBase(item.link)"><span class="fh-map-name">{{ item.text }}</span><span class="fh-map-note">{{ item.note }}</span></a>
</li>
</ul>
</div>
</div>
</section>

<section class="fh-band">
<div>
<h2 class="fh-h2">Who it is for</h2>
<p class="fh-text">Developers who build a web app or an API in <strong>TypeScript</strong> or <strong>Go</strong>, and have work that must not get lost: the emails after a sign-up, a payment webhook, a report every night. You see every run in the <a :href="dashboard" target="_blank" rel="noreferrer">dashboard</a>.</p>
</div>
<div class="fh-actions">
<a class="fh-btn brand" :href="withBase('/getting-started')">Do the quick start</a>
<a class="fh-btn" :href="withBase('/core-ideas')">Read the core ideas</a>
</div>
</section>
</div>
