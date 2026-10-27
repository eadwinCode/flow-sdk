import { defineConfig } from 'vitepress';

const repo = 'https://github.com/eadwinCode/flow-sdk';
const description = 'Background jobs, webhooks and crons that do not get lost, in TypeScript and Go.';

// Make heading anchors the way GitHub does: lower case, drop punctuation, spaces
// to dashes. The guides are also read on GitHub, and their links (like
// getting-started.md#1-sign-up-and-get-a-workspace) use GitHub's anchors. VitePress's own
// anchors differ (it would make "_1-sign-up-and-get-a-workspace"), so those links would
// miss on the site.
function githubSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

export default defineConfig({
  title: 'Clevix Flow',
  description,
  // Project page, so the site is served from /flow-sdk/ rather than the root.
  base: '/flow-sdk/',
  lastUpdated: true,
  cleanUrls: true,
  // README.md is kept for browsing the folder on GitHub; index.md is the site's
  // home. Without this both would build, as two routes with the same content.
  srcExclude: ['README.md'],

  markdown: {
    anchor: { slugify: githubSlug },
  },

  head: [
    // The look of flow.clevixstudio.com: its logo as the tab icon, its colours, and its fonts.
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/flow-sdk/logo.svg' }],
    // The phone's browser bar: navy, like the default (dark) theme. theme/index.ts changes
    // it when the reader switches to light.
    ['meta', { name: 'theme-color', content: '#0d1b2a' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap',
      },
    ],
    ['meta', { property: 'og:title', content: 'Clevix Flow docs' }],
    ['meta', { property: 'og:description', content: description }],
  ],

  // Dark by default for a new visitor. A reader can still switch. VitePress saves the
  // switch as "auto" when it matches their system, so a light pick on a light system
  // stays light only while the system stays light. Readers who visited before this
  // change already have "auto" saved and keep following their system.
  appearance: 'dark',

  themeConfig: {
    // Light mode: the full CLEVIX FLOW logo from flow.clevixstudio.com. Its "CLEVIX" is
    // navy, which would not show on the dark theme, so dark mode shows the mark and the
    // site name as text instead (custom.css hides that text in light mode).
    logo: { light: '/clevix-flow-logo.png', dark: '/logo.svg', alt: 'Clevix Flow' },
    siteTitle: '<span class="flow-site-title">Clevix Flow</span>',
    search: { provider: 'local' },

    nav: [
      { text: 'Start here', link: '/what-is-clevix-flow' },
      { text: 'Use cases', link: '/background-jobs' },
      { text: 'Guides', link: '/functions' },
      {
        text: 'Reference',
        items: [
          { text: 'TypeScript API', link: '/typescript' },
          { text: 'Go API', link: '/go' },
          { text: 'Settings', link: '/settings' },
          { text: 'HTTP API', link: '/http-api' },
          { text: 'Limits', link: '/limits' },
          { text: 'Protocol', link: '/protocol' },
        ],
      },
      { text: 'Changelog', link: `${repo}/blob/main/CHANGELOG.md` },
    ],

    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'What is Clevix Flow', link: '/what-is-clevix-flow' },
          { text: 'Core ideas', link: '/core-ideas' },
          { text: 'Quick start', link: '/getting-started' },
          { text: 'Local development', link: '/local-dev' },
        ],
      },
      {
        text: 'Use cases',
        items: [
          { text: 'Background jobs', link: '/background-jobs' },
          { text: 'Webhooks and events', link: '/webhooks' },
          { text: 'Crons and scheduled jobs', link: '/crons' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Functions and steps', link: '/functions' },
          { text: 'Events', link: '/events' },
          { text: 'Errors and retries', link: '/errors' },
          { text: 'Flow control', link: '/flow-control' },
          { text: 'Realtime', link: '/realtime' },
          { text: 'Going to production', link: '/production' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'TypeScript API', link: '/typescript' },
          { text: 'Go API', link: '/go' },
          { text: 'Settings', link: '/settings' },
          { text: 'HTTP API', link: '/http-api' },
          { text: 'Limits', link: '/limits' },
          { text: 'Protocol (for SDK authors)', link: '/protocol' },
        ],
      },
    ],

    socialLinks: [{ icon: 'github', link: repo }],

    editLink: {
      pattern: `${repo}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: `<a href="${repo}">github.com/eadwinCode/flow-sdk</a>`,
    },
  },
});
