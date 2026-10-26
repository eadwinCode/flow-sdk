// Checks what `vitepress build` does not:
//   - every `<<< @/../examples/...#region` names a file and a #region that exist
//     (VitePress 1.6 quietly shows the whole file when the region is missing);
//   - every link to a heading (page.md#anchor) points at a heading that exists,
//     with the same anchors the site makes (see githubSlug in .vitepress/config.ts).
// Run: node scripts/check-docs.mjs (part of `bun run docs:build`).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const docs = resolve(import.meta.dirname, "../docs");
const pages = readdirSync(docs).filter((f) => f.endsWith(".md"));

// The same rule as githubSlug in docs/.vitepress/config.ts.
const slug = (text) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");

const anchors = new Map();
for (const page of pages) {
  const text = readFileSync(join(docs, page), "utf8").replace(/```[\s\S]*?```/g, "");
  const set = new Set();
  for (const m of text.matchAll(/^#{1,6} (.+)$/gm)) set.add(slug(m[1].replace(/`/g, "")));
  anchors.set(page, set);
}

const problems = [];
for (const page of pages) {
  const text = readFileSync(join(docs, page), "utf8");
  for (const m of text.matchAll(/^<<< @\/(\S+?)(?:#([\w.-]+))?(?:\{[^}]*\})?(?: \[[^\]]*\])?\s*$/gm)) {
    const file = resolve(docs, m[1]);
    if (!existsSync(file)) {
      problems.push(`${page}: no file ${m[1]}`);
      continue;
    }
    if (m[2] && !readFileSync(file, "utf8").includes(`#region ${m[2]}\n`)) {
      problems.push(`${page}: ${m[1]} has no #region ${m[2]}`);
    }
  }
  for (const m of text.matchAll(/\]\(([a-z0-9-]+\.md)?#([^)]+)\)/g)) {
    const target = m[1] ?? page;
    if (!anchors.has(target)) problems.push(`${page}: no page ${target}`);
    else if (!anchors.get(target).has(m[2])) problems.push(`${page}: ${target} has no heading #${m[2]}`);
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`docs: ${pages.length} pages, snippets and anchors ok`);
