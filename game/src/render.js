// All drawing: the arena, the core, ships and enemies as bold neon shapes, the HUD, and
// the title, upgrade-draft, pause and game-over screens. Nothing here mutates the world;
// it reads state and paints it, big and high-contrast so the game reads at thumbnail size.

import {
  COLORS, CORE_RADIUS, CORE_X, CORE_Y, PLAYER_RADIUS, VIEW_HEIGHT, VIEW_WIDTH,
} from './config.js';
import { createRandom } from './random.js';
import {
  KIND_BOSS, KIND_CHASER, KIND_DASHER, KIND_MINI, KIND_SPLITTER, KIND_TANK,
} from './enemies.js';
import { SCREEN_OVER, SCREEN_PLAY, SCREEN_TITLE, SCREEN_UPGRADE } from './world.js';

const starRng = createRandom(20261115);
const STARS = Array.from({ length: 130 }, () => ({
  x: starRng.range(0, VIEW_WIDTH),
  y: starRng.range(0, VIEW_HEIGHT),
  r: starRng.range(0.6, 2.1),
  tw: starRng.range(0.4, 1),
}));

const ENEMY_COLORS = {
  [KIND_CHASER]: COLORS.chaser,
  [KIND_MINI]: COLORS.mini,
  [KIND_TANK]: COLORS.tank,
  [KIND_SPLITTER]: COLORS.splitter,
  [KIND_DASHER]: COLORS.dasher,
  [KIND_BOSS]: COLORS.boss,
};

function polygon(ctx, x, y, radius, sides, angle) {
  ctx.beginPath();
  for (let i = 0; i < sides; i += 1) {
    const a = angle + (i / sides) * Math.PI * 2;
    const px = x + Math.cos(a) * radius;
    const py = y + Math.sin(a) * radius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function bar(ctx, x, y, w, h, fraction, color, label) {
  ctx.fillStyle = 'rgba(6, 10, 24, 0.82)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = COLORS.panelEdge;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x + 2, y + 2, Math.max(0, (w - 4) * Math.min(1, fraction)), h - 4);
  if (label) {
    ctx.fillStyle = COLORS.text;
    ctx.font = 'bold 15px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 10, y + h / 2 + 1);
  }
}

function drawBackground(ctx, time) {
  const grad = ctx.createLinearGradient(0, 0, 0, VIEW_HEIGHT);
  grad.addColorStop(0, COLORS.background);
  grad.addColorStop(1, COLORS.backgroundDeep);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
  for (const star of STARS) {
    ctx.globalAlpha = 0.35 + 0.4 * star.tw * (0.6 + 0.4 * Math.sin(time * 1.7 + star.x));
    ctx.fillStyle = COLORS.star;
    ctx.fillRect(star.x, star.y, star.r, star.r);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = COLORS.gridLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 80; x < VIEW_WIDTH; x += 80) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, VIEW_HEIGHT);
  }
  for (let y = 80; y < VIEW_HEIGHT; y += 80) {
    ctx.moveTo(0, y);
    ctx.lineTo(VIEW_WIDTH, y);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(110, 150, 255, 0.4)';
  ctx.lineWidth = 3;
  ctx.strokeRect(6, 6, VIEW_WIDTH - 12, VIEW_HEIGHT - 12);
}

function drawCore(ctx, state) {
  const pulse = 1 + Math.sin(state.time * 2.4) * 0.05;
  const flash = state.coreFlash > 0;
  ctx.save();
  ctx.translate(CORE_X, CORE_Y);
  ctx.shadowColor = flash ? COLORS.danger : COLORS.core;
  ctx.shadowBlur = 34;
  ctx.fillStyle = flash ? '#ff8296' : COLORS.core;
  polygon(ctx, 0, 0, CORE_RADIUS * pulse, 6, state.time * 0.25);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = COLORS.coreRing;
  ctx.lineWidth = 4;
  polygon(ctx, 0, 0, (CORE_RADIUS + 13) * pulse, 6, -state.time * 0.4);
  ctx.stroke();
  ctx.fillStyle = '#fff3d6';
  polygon(ctx, 0, 0, CORE_RADIUS * 0.45 * pulse, 6, state.time * 0.25);
  ctx.fill();
  ctx.restore();
}

function drawPlayer(ctx, state) {
  const p = state.player;
  if (state.screen === SCREEN_OVER && state.overReason === 'ship') return;
  ctx.save();
  ctx.translate(p.x, p.y);
  if (p.invuln > 0 && Math.floor(state.time * 16) % 2 === 0) ctx.globalAlpha = 0.45;
  // Engine flame flickers behind the ship, opposite its aim.
  const flame = 10 + Math.sin(state.time * 31) * 4;
  ctx.fillStyle = '#ffb347';
  ctx.beginPath();
  ctx.moveTo(Math.cos(p.angle + Math.PI) * PLAYER_RADIUS, Math.sin(p.angle + Math.PI) * PLAYER_RADIUS);
  ctx.lineTo(Math.cos(p.angle + Math.PI * 2.6) * 7, Math.sin(p.angle + Math.PI * 2.6) * 7);
  ctx.lineTo(Math.cos(p.angle + Math.PI) * (PLAYER_RADIUS + flame), Math.sin(p.angle + Math.PI) * (PLAYER_RADIUS + flame));
  ctx.lineTo(Math.cos(p.angle + Math.PI * 1.4) * 7, Math.sin(p.angle + Math.PI * 1.4) * 7);
  ctx.closePath();
  ctx.fill();
  ctx.rotate(p.angle);
  ctx.shadowColor = COLORS.player;
  ctx.shadowBlur = 16;
  ctx.fillStyle = COLORS.player;
  ctx.beginPath();
  ctx.moveTo(PLAYER_RADIUS + 6, 0);
  ctx.lineTo(-PLAYER_RADIUS, PLAYER_RADIUS * 0.85);
  ctx.lineTo(-PLAYER_RADIUS * 0.55, 0);
  ctx.lineTo(-PLAYER_RADIUS, -PLAYER_RADIUS * 0.85);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = COLORS.playerCore;
  ctx.beginPath();
  ctx.arc(1, 0, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  if (p.shield > 0) {
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.75)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, PLAYER_RADIUS + 9, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawEnemy(ctx, e, time) {
  const color = e.hitFlash > 0.4 ? '#ffffff' : ENEMY_COLORS[e.kind];
  ctx.save();
  ctx.translate(e.x, e.y);
  ctx.shadowColor = ENEMY_COLORS[e.kind];
  ctx.shadowBlur = 12;
  ctx.fillStyle = color;
  switch (e.kind) {
    case KIND_CHASER:
      polygon(ctx, 0, 0, e.radius, 3, e.angle);
      ctx.fill();
      break;
    case KIND_MINI:
      polygon(ctx, 0, 0, e.radius, 3, e.angle);
      ctx.fill();
      break;
    case KIND_TANK:
      polygon(ctx, 0, 0, e.radius, 5, e.angle);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#ffd9b0';
      ctx.lineWidth = 3;
      polygon(ctx, 0, 0, e.radius * 0.58, 5, -e.angle * 0.6);
      ctx.stroke();
      break;
    case KIND_SPLITTER:
      ctx.rotate(e.angle * 0.4);
      ctx.fillRect(-e.radius, -e.radius, e.radius * 2, e.radius * 2);
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#eaffdf';
      const s = e.radius * 0.42;
      ctx.fillRect(-s, -s, s, s);
      ctx.fillRect(1, -s, s, s);
      ctx.fillRect(-s, 1, s, s);
      ctx.fillRect(1, 1, s, s);
      break;
    case KIND_DASHER: {
      const flashing = e.mode === 'windup' && Math.floor(time * 14) % 2 === 0;
      ctx.fillStyle = flashing ? '#ffffff' : color;
      polygon(ctx, 0, 0, e.radius + 3, 4, e.angle);
      ctx.fill();
      break;
    }
    case KIND_BOSS:
      polygon(ctx, 0, 0, e.radius, 6, e.angle * 0.3);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#efd0ff';
      ctx.lineWidth = 4;
      polygon(ctx, 0, 0, e.radius * 0.68, 6, -e.angle * 0.5);
      ctx.stroke();
      ctx.fillStyle = '#2a0a3d';
      polygon(ctx, 0, 0, e.radius * 0.34, 6, e.angle * 0.3);
      ctx.fill();
      ctx.fillStyle = '#ff5d5d';
      ctx.beginPath();
      ctx.arc(0, 0, 7 + Math.sin(time * 5) * 1.6, 0, Math.PI * 2);
      ctx.fill();
      break;
    default:
      ctx.beginPath();
      ctx.arc(0, 0, e.radius, 0, Math.PI * 2);
      ctx.fill();
  }
  ctx.restore();
  // A thin health arc over anything tougher than a chaser, once it is hurt.
  if (e.maxHp >= 40 && e.hp < e.maxHp && e.kind !== KIND_BOSS) {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.radius + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (e.hp / e.maxHp));
    ctx.stroke();
  }
}

function drawHud(ctx, state, ui) {
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 30px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`WAVE ${Math.max(1, state.wave)}`, 26, 36);
  ctx.font = 'bold 24px system-ui, sans-serif';
  ctx.fillText(`SCORE ${String(state.score).padStart(6, '0')}`, 26, 72);
  ctx.font = 'bold 17px system-ui, sans-serif';
  ctx.fillStyle = COLORS.textDim;
  ctx.fillText(`HOSTILES ${state.enemies.length + state.spawnQueue.length}`, 26, 102);
  ctx.textAlign = 'right';
  ctx.font = 'bold 20px system-ui, sans-serif';
  ctx.fillStyle = COLORS.shard;
  ctx.fillText(`◆ ${state.shardsCollected} SHARDS`, VIEW_WIDTH - 26, 36);
  ctx.fillStyle = COLORS.textDim;
  ctx.font = '16px system-ui, sans-serif';
  ctx.fillText(ui.muted ? 'M — SOUND OFF' : 'M — SOUND ON · P — PAUSE', VIEW_WIDTH - 26, 66);
  const p = state.player;
  bar(ctx, 26, VIEW_HEIGHT - 52, 300, 24, p.hp / p.maxHp, p.hp / p.maxHp < 0.3 ? COLORS.danger : '#4ade80', `SHIP ${Math.ceil(p.hp)}/${p.maxHp}`);
  if (p.shieldMax > 0) {
    bar(ctx, 26, VIEW_HEIGHT - 84, 300, 14, p.shield / p.shieldMax, '#7cc7ff', null);
  }
  bar(ctx, VIEW_WIDTH - 326, VIEW_HEIGHT - 52, 300, 24, state.coreHp / state.coreMaxHp, state.coreHp / state.coreMaxHp < 0.3 ? COLORS.danger : COLORS.core, `CORE ${Math.ceil(state.coreHp)}/${state.coreMaxHp}`);
  if (state.boss) {
    const b = state.boss;
    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.boss;
    ctx.font = 'bold 19px system-ui, sans-serif';
    ctx.fillText('☠ DREADNOUGHT', VIEW_WIDTH / 2, 28);
    bar(ctx, VIEW_WIDTH / 2 - 260, 42, 520, 16, b.hp / b.maxHp, COLORS.boss, null);
  }
  if (state.waveAnnounce > 0 && state.screen === SCREEN_PLAY) {
    ctx.textAlign = 'center';
    ctx.globalAlpha = Math.min(1, state.waveAnnounce);
    ctx.fillStyle = state.wave % 5 === 0 ? COLORS.boss : COLORS.text;
    ctx.font = 'bold 54px system-ui, sans-serif';
    ctx.fillText(state.wave % 5 === 0 ? `WAVE ${state.wave} — DREADNOUGHT` : `WAVE ${state.wave}`, VIEW_WIDTH / 2, 150);
    ctx.globalAlpha = 1;
  }
}

function panel(ctx, x, y, w, h) {
  ctx.fillStyle = COLORS.panel;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = COLORS.panelEdge;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
}

/** The three upgrade cards' rectangles, shared by the painter and click handling. */
export function upgradeCardRects() {
  const rects = [];
  const w = 340;
  const h = 200;
  const gap = 30;
  const startX = (VIEW_WIDTH - (w * 3 + gap * 2)) / 2;
  for (let i = 0; i < 3; i += 1) rects.push({ x: startX + i * (w + gap), y: 300, w, h });
  return rects;
}

export function upgradeCardAt(x, y) {
  const rects = upgradeCardRects();
  for (let i = 0; i < rects.length; i += 1) {
    const r = rects[i];
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return i;
  }
  return -1;
}

function drawTitle(ctx, state, ui) {
  ctx.fillStyle = 'rgba(3, 5, 14, 0.55)';
  ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
  ctx.textAlign = 'center';
  ctx.shadowColor = COLORS.player;
  ctx.shadowBlur = 26;
  ctx.fillStyle = COLORS.player;
  ctx.font = 'bold 92px system-ui, sans-serif';
  ctx.fillText('STARFALL', VIEW_WIDTH / 2, 196);
  ctx.shadowColor = COLORS.core;
  ctx.fillStyle = COLORS.core;
  ctx.fillText('BASTION', VIEW_WIDTH / 2, 282);
  ctx.shadowBlur = 0;
  ctx.fillStyle = COLORS.text;
  ctx.font = '24px system-ui, sans-serif';
  ctx.fillText('Pilot the last defence ship. Hold the core against the swarm.', VIEW_WIDTH / 2, 348);
  ctx.fillStyle = COLORS.textDim;
  ctx.font = '21px system-ui, sans-serif';
  ctx.fillText('WASD / ARROWS — fly      MOUSE — aim      CLICK / SPACE — fire', VIEW_WIDTH / 2, 420);
  ctx.fillText('Survive the wave, draft an upgrade, face the Dreadnought every 5th wave.', VIEW_WIDTH / 2, 452);
  const blink = ui.shot || Math.floor(state.time * 1.6) % 2 === 0;
  if (blink) {
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 30px system-ui, sans-serif';
    ctx.fillText('CLICK OR PRESS ENTER TO START', VIEW_WIDTH / 2, 540);
  }
  if (ui.best > 0) {
    ctx.fillStyle = COLORS.shard;
    ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.fillText(`BEST SCORE ${ui.best}`, VIEW_WIDTH / 2, 596);
  }
}

function drawUpgrade(ctx, state) {
  ctx.fillStyle = 'rgba(3, 5, 14, 0.72)';
  ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#4ade80';
  ctx.font = 'bold 52px system-ui, sans-serif';
  ctx.fillText(`WAVE ${state.wave} CLEARED`, VIEW_WIDTH / 2, 168);
  ctx.fillStyle = COLORS.text;
  ctx.font = '24px system-ui, sans-serif';
  ctx.fillText(`Bonus +${100 + state.wave * 25} — choose one upgrade for the next wave`, VIEW_WIDTH / 2, 214);
  const rects = upgradeCardRects();
  state.upgradesOffered.forEach((upgrade, i) => {
    const r = rects[i];
    panel(ctx, r.x, r.y, r.w, r.h);
    ctx.fillStyle = COLORS.bullet;
    ctx.font = 'bold 52px system-ui, sans-serif';
    ctx.fillText(upgrade.icon, r.x + r.w / 2, r.y + 58);
    ctx.fillStyle = COLORS.text;
    ctx.font = 'bold 27px system-ui, sans-serif';
    ctx.fillText(upgrade.name, r.x + r.w / 2, r.y + 112);
    ctx.fillStyle = COLORS.textDim;
    ctx.font = '17px system-ui, sans-serif';
    const words = upgrade.describe(draftPreviewStats(state)).split(' ');
    let line = '';
    let lineY = r.y + 146;
    for (const word of words) {
      if ((line + ' ' + word).trim().length > 34) {
        ctx.fillText(line.trim(), r.x + r.w / 2, lineY);
        line = word;
        lineY += 21;
      } else {
        line += ' ' + word;
      }
    }
    ctx.fillText(line.trim(), r.x + r.w / 2, lineY);
    ctx.fillStyle = COLORS.panelEdge;
    ctx.font = 'bold 16px system-ui, sans-serif';
    ctx.fillText(`PRESS ${i + 1}`, r.x + r.w / 2, r.y + r.h - 14);
  });
}

/** A read-only stat view so upgrade cards can describe their effect before it is applied. */
function draftPreviewStats(state) {
  const p = state.player;
  return {
    fireRate: p.fireRate, damage: p.damage, projectiles: p.projectiles, moveSpeed: p.moveSpeed,
    shieldMax: p.shieldMax, shield: p.shield, coreMaxHp: state.coreMaxHp, coreHp: state.coreHp,
    coreRegen: state.coreRegen,
    magnetRadius: p.magnetRadius, hp: p.hp, maxHp: p.maxHp, regen: p.regen, pierce: p.pierce,
  };
}

function drawOver(ctx, state, ui) {
  ctx.fillStyle = 'rgba(10, 2, 8, 0.78)';
  ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
  ctx.textAlign = 'center';
  ctx.shadowColor = COLORS.danger;
  ctx.shadowBlur = 22;
  ctx.fillStyle = COLORS.danger;
  ctx.font = 'bold 64px system-ui, sans-serif';
  ctx.fillText(state.overReason === 'core' ? 'THE CORE HAS FALLEN' : 'SHIP DESTROYED', VIEW_WIDTH / 2, 190);
  ctx.shadowBlur = 0;
  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 34px system-ui, sans-serif';
  ctx.fillText(`FINAL SCORE ${state.score}`, VIEW_WIDTH / 2, 268);
  ctx.font = '24px system-ui, sans-serif';
  ctx.fillStyle = COLORS.textDim;
  ctx.fillText(`Waves survived: ${state.wave}`, VIEW_WIDTH / 2, 322);
  ctx.fillText(`Enemies destroyed: ${state.kills}`, VIEW_WIDTH / 2, 356);
  ctx.fillText(`Shards recovered: ${state.shardsCollected}`, VIEW_WIDTH / 2, 390);
  if (state.score >= ui.best && state.score > 0) {
    ctx.fillStyle = COLORS.shard;
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.fillText('★ NEW BEST SCORE ★', VIEW_WIDTH / 2, 432);
  }
  const blink = ui.shot || Math.floor(state.time * 1.6) % 2 === 0;
  if (blink) {
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 28px system-ui, sans-serif';
    ctx.fillText('PRESS ENTER OR CLICK TO RESTART', VIEW_WIDTH / 2, 500);
  }
}

/** Paint one frame. `ui` carries shell-level facts the world does not own (best, muted). */
export function drawScene(ctx, world, ui) {
  const { state } = world;
  ctx.save();
  if (state.shake > 0.2) {
    ctx.translate((Math.random() - 0.5) * state.shake, (Math.random() - 0.5) * state.shake);
  }
  drawBackground(ctx, state.time);
  drawCore(ctx, state);
  for (const s of state.shards) {
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(state.time * 3);
    ctx.fillStyle = COLORS.shard;
    ctx.shadowColor = COLORS.shard;
    ctx.shadowBlur = 9;
    ctx.fillRect(-5, -5, 10, 10);
    ctx.restore();
  }
  for (const orb of state.orbs) {
    ctx.fillStyle = COLORS.orb;
    ctx.shadowColor = COLORS.orb;
    ctx.shadowBlur = 13;
    ctx.beginPath();
    ctx.arc(orb.x, orb.y, orb.radius + Math.sin(state.time * 9) * 1.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  for (const e of state.enemies) drawEnemy(ctx, e, state.time);
  for (const b of state.bullets) {
    ctx.fillStyle = COLORS.bullet;
    ctx.shadowColor = COLORS.bullet;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  drawPlayer(ctx, state);
  world.particles.draw(ctx);
  ctx.restore();

  if (state.screen === SCREEN_PLAY || state.screen === SCREEN_UPGRADE) drawHud(ctx, state, ui);
  if (state.screen === SCREEN_TITLE) drawTitle(ctx, state, ui);
  if (state.screen === SCREEN_UPGRADE) drawUpgrade(ctx, state);
  if (state.paused && state.screen === SCREEN_PLAY) {
    ctx.fillStyle = 'rgba(3, 5, 14, 0.6)';
    ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.text;
    ctx.font = 'bold 56px system-ui, sans-serif';
    ctx.fillText('PAUSED', VIEW_WIDTH / 2, VIEW_HEIGHT / 2);
    ctx.font = '22px system-ui, sans-serif';
    ctx.fillStyle = COLORS.textDim;
    ctx.fillText('P or Esc to resume', VIEW_WIDTH / 2, VIEW_HEIGHT / 2 + 48);
  }
  if (state.screen === SCREEN_OVER) drawOver(ctx, state, ui);
}
