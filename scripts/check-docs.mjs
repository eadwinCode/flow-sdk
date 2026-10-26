// Checks what `vitepress build` does not:
//   - every `<<< @/../examples/...#region` names a file and a #region that exist,
//     with a matching #endregion after it (VitePress 1.6 quietly shows the whole
//     file when the region is missing);
//   - every link to a heading (page.md#anchor) points at a heading that exists,
//     with the same anchors the site makes (see githubSlug in .vitepress/config.ts).
// Run: node scripts/check-docs.mjs (part of `bun run docs:build`).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const docs = resolve(import.meta.dirname, "../docs");
// Line ends as \n, so a file saved with CRLF (\r\n) is checked the same way.
const read = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
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
  const text = read(join(docs, page)).replace(/```[\s\S]*?```/g, "");
  const set = new Set();
  for (const m of text.matchAll(/^#{1,6} (.+)$/gm)) set.add(slug(m[1].replace(/`/g, "")));
  anchors.set(page, set);
}

const problems = [];
for (const page of pages) {
  const text = read(join(docs, page));
  for (const m of text.matchAll(/^<<< @\/(\S+?)(?:#([\w.-]+))?(?:\{[^}]*\})?(?: \[[^\]]*\])?\s*$/gm)) {
    const file = resolve(docs, m[1]);
    if (!existsSync(file)) {
      problems.push(`${page}: no file ${m[1]}`);
      continue;
    }
    if (m[2]) {
      const problem = regionProblem(read(file), m[2]);
      if (problem) problems.push(`${page}: ${m[1]} ${problem}`);
    }
  }
  for (const m of text.matchAll(/\]\(([a-z0-9-]+\.md)?#([^)]+)\)/g)) {
    const target = m[1] ?? page;
    if (!anchors.has(target)) problems.push(`${page}: no page ${target}`);
    else if (!anchors.get(target).has(m[2])) problems.push(`${page}: ${target} has no heading #${m[2]}`);
  }
}

// The #region line, then a #endregion line for the same name after it.
function regionProblem(source, name) {
  const lines = source.split("\n").map((line) => line.trimEnd());
  const start = lines.findIndex((line) => line.endsWith(`#region ${name}`));
  if (start === -1) return `has no #region ${name}`;
  if (!lines.slice(start + 1).some((line) => line.endsWith(`#endregion ${name}`))) {
    return `has #region ${name} but no #endregion ${name} after it`;
  }
  return null;
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`docs: ${pages.length} pages, snippets and anchors ok`);
