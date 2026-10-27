// The default VitePress theme, with the colours, fonts and corners of
// flow.clevixstudio.com (see custom.css). The "without fonts" entry leaves out
// VitePress's own font (Inter), which the site does not use.
import DefaultTheme from 'vitepress/theme-without-fonts';
import { useData } from 'vitepress';
import { watch } from 'vue';
import type { Theme } from 'vitepress';
import './custom.css';

/** The phone's browser bar colour for each theme: navy in dark, the page colour in light. */
const BAR_COLOR = { dark: '#0d1b2a', light: '#fbfaf7' };

export default {
  extends: DefaultTheme,
  setup() {
    const { isDark } = useData();
    // config.ts sets the tag for the first paint (dark, the default). This keeps it
    // matching the theme when the reader switches. Browser only: there is no document
    // while the site is built.
    if (typeof document === 'undefined') return;
    watch(
      isDark,
      (dark) => {
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? BAR_COLOR.dark : BAR_COLOR.light);
      },
      { immediate: true },
    );
  },
} satisfies Theme;
