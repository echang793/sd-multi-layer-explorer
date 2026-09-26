// Lint for the single-file app: syntax-check every inline <script>, flag duplicate
// element ids, and catch literal NaN / "undefined" leaking into static markup.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const file = fileURLToPath(new URL('../src/index.html', import.meta.url));
const html = readFileSync(file, 'utf8');
const problems = [];

const lineOf = (idx) => html.slice(0, idx).split('\n').length;

// 1. Inline scripts must parse.
const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
let m;
let scripts = 0;
while ((m = scriptRe.exec(html))) {
  scripts++;
  try {
    new vm.Script(m[1], { filename: `index.html:${lineOf(m.index)}` });
  } catch (err) {
    problems.push(`script at line ${lineOf(m.index)}: ${err.message}`);
  }
}

// 2. Static element ids must be unique.
const seen = new Map();
for (const im of html.matchAll(/\sid="([^"]+)"/g)) {
  const id = im[1];
  if (seen.has(id)) problems.push(`duplicate id "${id}" (lines ${seen.get(id)} and ${lineOf(im.index)})`);
  else seen.set(id, lineOf(im.index));
}

// 3. No NaN / undefined text baked into markup outside scripts.
const markup = html.replace(scriptRe, '').replace(/<style[\s\S]*?<\/style>/g, '');
for (const bad of ['>NaN<', '>undefined<']) {
  if (markup.includes(bad)) problems.push(`literal ${bad} in markup`);
}

if (problems.length) {
  console.error(`lint: ${problems.length} problem(s)\n  ` + problems.join('\n  '));
  process.exit(1);
}
console.log(`lint: ok (${scripts} inline scripts parsed, ${seen.size} unique ids)`);
