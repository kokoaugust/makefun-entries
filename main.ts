// Emberline Depot's hand-in program (Node 22, standard library only). The game is this
// repository's game/ folder — plain static files a browser loads as ES modules, three.js
// arriving through an import map — and screenshots/ holds its maker's captures. This program
// copies both to /output and writes /output/dossier.json, the summary the judge reads, with
// the vendored make.fun library, so the dossier is byte for byte the one the scorer rebuilds.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
// Play the game locally with `node serve.ts`, then open http://localhost:8080.

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });
if (existsSync(join(here, 'screenshots'))) {
  cpSync(join(here, 'screenshots'), join(out, 'screenshots'), { recursive: true });
}

// The caps are the scorer's own (reference/gate.json). Only text_max_bytes shapes the bytes;
// the rest make this program refuse an entry the scorer would refuse anyway — more than four
// screenshots or one over 256 KiB, more than 993 entries or 48 MiB under game/.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
  }),
);
