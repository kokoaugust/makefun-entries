// Starfall Bastion — the program that hands the game in (Node 22, standard library only).
//
// The game itself is the static site in game/: game/index.html and its ES modules, no
// library, no build step, nothing fetched. This program copies game/ and screenshots/
// into the output directory and writes dossier.json there with buildDossier from the
// kit's vendored library, under the scorer's own caps, so the dossier the judge reads
// is exactly the one the gate rebuilds.
//
// Outside the grader, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(outputDir, { recursive: true });
cpSync(join(repoRoot, 'game'), join(outputDir, 'game'), { recursive: true });

const screenshotsDir = join(outputDir, 'screenshots');
mkdirSync(screenshotsDir, { recursive: true });
if (existsSync(join(repoRoot, 'screenshots'))) {
  cpSync(join(repoRoot, 'screenshots'), screenshotsDir, { recursive: true });
}

const dossier = buildDossier(outputDir, {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
});
writeFileSync(join(outputDir, 'dossier.json'), dossier);
console.log(`starfall-bastion: wrote game/, screenshots/ and dossier.json (${dossier.length} bytes) to ${outputDir}`);
