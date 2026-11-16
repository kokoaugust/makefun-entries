// main.ts — harness driver for the markdown-render-speed-02 entry.
// Reads every case from /input/cases.json, renders each case's markdown
// with parse() from ./parse.js, and writes the HTML strings, in order,
// to /output/html.json.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from './parse.js';

interface CaseInput {
  id: string;
  markdown: string;
}

function main(): void {
  const raw = readFileSync('/input/cases.json', 'utf8');
  const cases = JSON.parse(raw) as CaseInput[];
  const html: string[] = new Array(cases.length);
  for (let i = 0; i < cases.length; i++) {
    html[i] = parse(cases[i].markdown);
  }
  mkdirSync('/output', { recursive: true });
  writeFileSync('/output/html.json', JSON.stringify(html));
}

main();
