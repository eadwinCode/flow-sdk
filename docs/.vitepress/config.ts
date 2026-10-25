import { defineConfig } from 'vitepress';

const repo = 'https://github.com/eadwinCode/flow-sdk';
const description = 'Durable functions made of steps, in TypeScript and Go.';

// Make heading anchors the way GitHub does: lower case, drop punctuation, spaces
// to dashes. The guides are also read on GitHub, and their links (like
// getting-started.md#1-get-your-apps-keys) use GitHub's anchors. VitePress's own
// anchors differ (it would make "_1-get-your-app-s-keys"), so those links would
// miss on the site.
function githubSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

export default defineConfig({
  title: 'flow-sdk',
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
    ['meta', { property: 'og:title', content: 'flow-sdk' }],
    ['meta', { property: 'og:description', content: description }],
  ],

  themeConfig: {
    search: { provider: 'local' },

    nav: [
      { text: 'Getting started', link: '/getting-started' },
      { text: 'Guides', link: '/functions' },
      {
        text: 'Reference',
        items: [
          { text: 'TypeScript', link: '/typescript' },
          { text: 'Go', link: '/go' },
          { text: 'Protocol', link: '/protocol' },
        ],
      },
      { text: 'Changelog', link: `${repo}/blob/main/CHANGELOG.md` },
    ],

    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Getting started', link: '/getting-started' },
          { text: 'Local development', link: '/local-dev' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Functions and steps', link: '/functions' },
          { text: 'Events', link: '/events' },
          { text: 'Scheduling', link: '/scheduling' },
          { text: 'Flow control', link: '/flow-control' },
          { text: 'Realtime', link: '/realtime' },
          { text: 'Production', link: '/production' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'TypeScript SDK', link: '/typescript' },
          { text: 'Go SDK', link: '/go' },
          { text: 'SDK protocol', link: '/protocol' },
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
