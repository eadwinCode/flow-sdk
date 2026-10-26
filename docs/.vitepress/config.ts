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
    ['meta', { name: 'theme-color', content: '#3c8772' }],
    ['meta', { property: 'og:title', content: 'Clevix Flow docs' }],
    ['meta', { property: 'og:description', content: description }],
  ],

  themeConfig: {
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
          { text: 'Coming from Inngest', link: '/coming-from-inngest' },
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
