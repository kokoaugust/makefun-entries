// The simulation: player ship, the bastion core, bullets, orbs, shards, waves and the
// screen state machine (title -> play -> upgrade draft -> play ... -> game over). Pure
// fixed-step logic with a seeded random, so any run — or screenshot scene — replays exactly.

import {
  ARENA_MARGIN, BOSS_CORE_DPS, BULLET_LIFE_SECONDS, BULLET_RADIUS, BULLET_SPEED, COLORS, CORE_MAX_HP,
  CORE_RADIUS, CORE_X, CORE_Y, PLAYER_HIT_INVULN_SECONDS, PLAYER_MAX_HP, PLAYER_RADIUS,
  PLAYER_SPEED, SHARD_ATTRACT_SPEED, SHARD_MAGNET_BASE, SHARD_SCORE, VIEW_HEIGHT, VIEW_WIDTH,
} from './config.js';
import { createRandom } from './random.js';
import { createParticles } from './particles.js';
import {
  KIND_BOSS, KIND_CHASER, KIND_MINI, KIND_SPLITTER, createEnemy, spawnInterval, updateEnemy, wavePlan,
} from './enemies.js';
import { drawUpgrades } from './upgrades.js';

export const SCREEN_TITLE = 'title';
export const SCREEN_PLAY = 'play';
export const SCREEN_UPGRADE = 'upgrade';
export const SCREEN_OVER = 'over';

function freshPlayer() {
  return {
    x: CORE_X, y: CORE_Y + 120, vx: 0, vy: 0, angle: -Math.PI / 2,
    hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP,
    fireRate: 5, damage: 11, projectiles: 1, moveSpeed: PLAYER_SPEED,
    shield: 0, shieldMax: 0, shieldRegenTimer: 0,
    magnetRadius: SHARD_MAGNET_BASE, pierce: 0, regen: 0,
    fireCooldown: 0, invuln: 0,
  };
}

export function createWorld(seed) {
  const rng = createRandom(seed);
  const particles = createParticles();
  const state = {
    screen: SCREEN_TITLE,
    paused: false,
    time: 0,
    wave: 0,
    score: 0,
    kills: 0,
    shardsCollected: 0,
    player: freshPlayer(),
    coreHp: CORE_MAX_HP,
    coreMaxHp: CORE_MAX_HP,
    coreRegen: 0,
    coreFlash: 0,
    enemies: [],
    bullets: [],
    orbs: [],
    shards: [],
    spawnQueue: [],
    spawnTimer: 0,
    upgradesOffered: [],
    shake: 0,
    events: [],
    boss: null,
    waveAnnounce: 0,
  };

  function emit(name, data = {}) {
    state.events.push({ name, ...data });
  }

  function startWave() {
    state.spawnQueue = wavePlan(state.wave, rng);
    state.spawnTimer = 0.8;
    state.waveAnnounce = 2.2;
    emit('waveStart', { wave: state.wave });
  }

  function startRun() {
    state.screen = SCREEN_PLAY;
    state.paused = false;
    state.wave = 1;
    state.score = 0;
    state.kills = 0;
    state.shardsCollected = 0;
    state.player = freshPlayer();
    state.coreHp = CORE_MAX_HP;
    state.coreMaxHp = CORE_MAX_HP;
    state.coreRegen = 0;
    state.enemies.length = 0;
    state.bullets.length = 0;
    state.orbs.length = 0;
    state.shards.length = 0;
    state.boss = null;
    particles.clear();
    startWave();
  }

  function gameOver(reason) {
    state.screen = SCREEN_OVER;
    state.overReason = reason;
    particles.burst(CORE_X, CORE_Y, COLORS.core, 90, rng, 420, 4);
    particles.burst(state.player.x, state.player.y, COLORS.player, 60, rng, 360, 4);
    state.shake = 14;
    emit('gameOver', { reason });
  }

  function spawnFromQueue() {
    const kind = state.spawnQueue.shift();
    // Spawn on a random arena edge, never on top of the player.
    let x = 0;
    let y = 0;
    for (let tries = 0; tries < 8; tries += 1) {
      const edge = rng.int(0, 3);
      if (edge === 0) { x = rng.range(30, VIEW_WIDTH - 30); y = 24; }
      else if (edge === 1) { x = rng.range(30, VIEW_WIDTH - 30); y = VIEW_HEIGHT - 24; }
      else if (edge === 2) { x = 24; y = rng.range(30, VIEW_HEIGHT - 30); }
      else { x = VIEW_WIDTH - 24; y = rng.range(30, VIEW_HEIGHT - 30); }
      if (Math.hypot(x - state.player.x, y - state.player.y) > 240) break;
    }
    const enemy = createEnemy(kind, x, y, state.wave);
    state.enemies.push(enemy);
    if (kind === KIND_BOSS) {
      state.boss = enemy;
      emit('bossWarn', { wave: state.wave });
    }
    particles.burst(x, y, '#5f7cff', 10, rng, 120, 2);
  }

  function killEnemy(enemy, index) {
    state.enemies.splice(index, 1);
    state.score += enemy.score;
    state.kills += 1;
    const big = enemy.kind === KIND_BOSS || enemy.radius >= 24;
    particles.burst(enemy.x, enemy.y, enemy.kind === KIND_BOSS ? COLORS.boss : '#ffffff', big ? 46 : 18, rng, big ? 380 : 280, big ? 4 : 3);
    particles.burst(enemy.x, enemy.y, COLORS.chaser, 8, rng, 200, 2);
    state.shake = Math.min(12, state.shake + (big ? 7 : 1.6));
    emit('explosion', { big, x: enemy.x, y: enemy.y });
    const shardCount = enemy.kind === KIND_BOSS ? 10 : rng.int(1, 3);
    for (let i = 0; i < shardCount; i += 1) {
      const angle = rng.angle();
      state.shards.push({
        x: enemy.x, y: enemy.y,
        vx: Math.cos(angle) * rng.range(30, 130), vy: Math.sin(angle) * rng.range(30, 130),
        value: SHARD_SCORE,
      });
    }
    if (enemy.kind === KIND_SPLITTER) {
      for (let i = 0; i < 2; i += 1) {
        const mini = createEnemy(KIND_MINI, enemy.x + rng.range(-16, 16), enemy.y + rng.range(-16, 16), state.wave);
        state.enemies.push(mini);
      }
    }
    if (enemy.kind === KIND_BOSS) state.boss = null;
  }

  function damagePlayer(amount) {
    const p = state.player;
    if (p.invuln > 0 || state.screen !== SCREEN_PLAY) return;
    let remaining = amount;
    if (p.shield > 0) {
      const absorbed = Math.min(p.shield, remaining);
      p.shield -= absorbed;
      remaining -= absorbed;
      p.shieldRegenTimer = 3;
      emit('shieldHit', {});
    }
    if (remaining > 0) {
      p.hp -= remaining;
      p.shieldRegenTimer = 3;
      emit('hurt', {});
    }
    p.invuln = PLAYER_HIT_INVULN_SECONDS;
    state.shake = Math.min(12, state.shake + 4);
    if (p.hp <= 0) {
      p.hp = 0;
      gameOver('ship');
    }
  }

  function damageCore(amount) {
    state.coreHp -= amount;
    state.coreFlash = 1;
    emit('coreHurt', {});
    if (state.coreHp <= 0) {
      state.coreHp = 0;
      gameOver('core');
    }
  }

  function fireBullets() {
    const p = state.player;
    const baseAngle = Math.atan2(p.aimY - p.y, p.aimX - p.x);
    p.angle = baseAngle;
    for (let i = 0; i < p.projectiles; i += 1) {
      const offset = (i - (p.projectiles - 1) / 2) * 0.085;
      const angle = baseAngle + offset;
      state.bullets.push({
        x: p.x + Math.cos(baseAngle) * (PLAYER_RADIUS + 6),
        y: p.y + Math.sin(baseAngle) * (PLAYER_RADIUS + 6),
        vx: Math.cos(angle) * BULLET_SPEED,
        vy: Math.sin(angle) * BULLET_SPEED,
        life: BULLET_LIFE_SECONDS,
        damage: p.damage,
        pierceLeft: p.pierce,
      });
    }
    particles.sparks(p.x + Math.cos(baseAngle) * 22, p.y + Math.sin(baseAngle) * 22, COLORS.bullet, 2, rng, baseAngle);
    emit('shoot', {});
  }

  function stepPlayer(dt, control) {
    const p = state.player;
    p.invuln = Math.max(0, p.invuln - dt);
    p.fireCooldown = Math.max(0, p.fireCooldown - dt);
    if (p.regen > 0) p.hp = Math.min(p.maxHp, p.hp + p.regen * dt);
    if (p.shieldMax > 0) {
      p.shieldRegenTimer = Math.max(0, p.shieldRegenTimer - dt);
      if (p.shieldRegenTimer <= 0) p.shield = Math.min(p.shieldMax, p.shield + 14 * dt);
    }
    p.vx = control.moveX * p.moveSpeed;
    p.vy = control.moveY * p.moveSpeed;
    p.x = Math.min(VIEW_WIDTH - ARENA_MARGIN, Math.max(ARENA_MARGIN, p.x + p.vx * dt));
    p.y = Math.min(VIEW_HEIGHT - ARENA_MARGIN, Math.max(ARENA_MARGIN, p.y + p.vy * dt));
    // The ship cannot fly through the core it defends.
    const dx = p.x - CORE_X;
    const dy = p.y - CORE_Y;
    const dist = Math.hypot(dx, dy);
    const minDist = CORE_RADIUS + PLAYER_RADIUS + 4;
    if (dist > 0 && dist < minDist) {
      p.x = CORE_X + (dx / dist) * minDist;
      p.y = CORE_Y + (dy / dist) * minDist;
    }
    p.aimX = control.aimX;
    p.aimY = control.aimY;
    if (control.firing && p.fireCooldown <= 0) {
      p.fireCooldown = 1 / p.fireRate;
      fireBullets();
    } else if (!control.firing) {
      p.angle = Math.atan2(control.aimY - p.y, control.aimX - p.x);
    }
  }

  function stepBullets(dt) {
    for (let i = state.bullets.length - 1; i >= 0; i -= 1) {
      const b = state.bullets[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
      let dead = b.life <= 0 || b.x < -20 || b.x > VIEW_WIDTH + 20 || b.y < -20 || b.y > VIEW_HEIGHT + 20;
      if (!dead) {
        // Orbs can be shot down.
        for (let j = state.orbs.length - 1; j >= 0; j -= 1) {
          const orb = state.orbs[j];
          if (Math.hypot(orb.x - b.x, orb.y - b.y) < orb.radius + BULLET_RADIUS) {
            state.orbs.splice(j, 1);
            state.score += 10;
            particles.burst(orb.x, orb.y, COLORS.orb, 8, rng, 180, 2);
            dead = true;
            break;
          }
        }
      }
      if (!dead) {
        for (let j = state.enemies.length - 1; j >= 0; j -= 1) {
          const e = state.enemies[j];
          if (Math.hypot(e.x - b.x, e.y - b.y) < e.radius + BULLET_RADIUS) {
            e.hp -= b.damage;
            e.hitFlash = 1;
            const dir = Math.atan2(b.vy, b.vx);
            e.knockX += Math.cos(dir) * (e.kind === KIND_BOSS ? 12 : 130);
            e.knockY += Math.sin(dir) * (e.kind === KIND_BOSS ? 12 : 130);
            particles.sparks(b.x, b.y, '#ffffff', 4, rng, dir + Math.PI);
            emit('hit', {});
            if (e.hp <= 0) killEnemy(e, j);
            if (b.pierceLeft > 0) {
              b.pierceLeft -= 1;
            } else {
              dead = true;
            }
            break;
          }
        }
      }
      if (dead) state.bullets.splice(i, 1);
    }
  }

  function stepEnemies(dt) {
    const ctx = {
      playerX: state.player.x,
      playerY: state.player.y,
      coreX: CORE_X,
      coreY: CORE_Y,
      onBossSpawn(boss) {
        for (let i = 0; i < 2; i += 1) {
          state.enemies.push(createEnemy(KIND_MINI, boss.x + rng.range(-40, 40), boss.y + rng.range(-40, 40), state.wave));
        }
      },
      onBossOrbs(boss) {
        for (let i = 0; i < 3; i += 1) {
          const angle = Math.atan2(state.player.y - boss.y, state.player.x - boss.x) + (i - 1) * 0.35;
          state.orbs.push({
            x: boss.x, y: boss.y,
            vx: Math.cos(angle) * 205, vy: Math.sin(angle) * 205,
            radius: 7, life: 4.5,
          });
        }
        emit('orbFire', {});
      },
    };
    for (let i = state.enemies.length - 1; i >= 0; i -= 1) {
      const e = state.enemies[i];
      updateEnemy(e, ctx, dt);
      const distCore = Math.hypot(e.x - CORE_X, e.y - CORE_Y);
      if (e.kind === KIND_BOSS) {
        const ring = CORE_RADIUS + e.radius + 4;
        if (distCore < ring) {
          const nx = (e.x - CORE_X) / (distCore || 1);
          const ny = (e.y - CORE_Y) / (distCore || 1);
          e.x = CORE_X + nx * ring;
          e.y = CORE_Y + ny * ring;
          damageCore(BOSS_CORE_DPS * dt);
        }
      } else if (distCore < CORE_RADIUS + e.radius * 0.7) {
        damageCore(e.coreDamage);
        particles.burst(e.x, e.y, COLORS.core, 16, rng, 240, 3);
        state.enemies.splice(i, 1);
        if (state.screen !== SCREEN_PLAY) return;
        continue;
      }
      const distPlayer = Math.hypot(e.x - state.player.x, e.y - state.player.y);
      if (distPlayer < e.radius + PLAYER_RADIUS) {
        damagePlayer(e.contactDamage);
        if (e.kind === KIND_MINI || e.kind === KIND_CHASER) {
          killEnemy(e, i);
        } else {
          e.hp -= 18;
          e.knockX += ((e.x - state.player.x) / (distPlayer || 1)) * 320;
          e.knockY += ((e.y - state.player.y) / (distPlayer || 1)) * 320;
          if (e.hp <= 0) killEnemy(e, i);
        }
        if (state.screen !== SCREEN_PLAY) return;
      }
    }
  }

  function stepOrbs(dt) {
    for (let i = state.orbs.length - 1; i >= 0; i -= 1) {
      const orb = state.orbs[i];
      orb.x += orb.vx * dt;
      orb.y += orb.vy * dt;
      orb.life -= dt;
      if (Math.hypot(orb.x - state.player.x, orb.y - state.player.y) < orb.radius + PLAYER_RADIUS) {
        damagePlayer(12);
        state.orbs.splice(i, 1);
        continue;
      }
      if (orb.life <= 0 || orb.x < -30 || orb.x > VIEW_WIDTH + 30 || orb.y < -30 || orb.y > VIEW_HEIGHT + 30) {
        state.orbs.splice(i, 1);
      }
    }
  }

  function stepShards(dt) {
    const p = state.player;
    for (let i = state.shards.length - 1; i >= 0; i -= 1) {
      const s = state.shards[i];
      const dx = p.x - s.x;
      const dy = p.y - s.y;
      const dist = Math.hypot(dx, dy);
      if (dist < p.magnetRadius) {
        const pull = SHARD_ATTRACT_SPEED * (1.2 - dist / Math.max(1, p.magnetRadius));
        s.vx += (dx / (dist || 1)) * pull * dt * 4;
        s.vy += (dy / (dist || 1)) * pull * dt * 4;
      }
      s.vx *= Math.max(0, 1 - 2.4 * dt);
      s.vy *= Math.max(0, 1 - 2.4 * dt);
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      if (dist < PLAYER_RADIUS + 10) {
        state.score += s.value;
        state.shardsCollected += 1;
        particles.sparks(s.x, s.y, COLORS.shard, 3, rng, rng.angle());
        emit('pickup', {});
        state.shards.splice(i, 1);
      }
    }
  }

  function step(dt, control) {
    state.time += dt;
    state.coreFlash = Math.max(0, state.coreFlash - dt * 3.2);
    state.waveAnnounce = Math.max(0, state.waveAnnounce - dt);
    state.shake *= Math.max(0, 1 - 7 * dt);
    if (state.screen !== SCREEN_PLAY || state.paused) {
      particles.update(dt);
      return;
    }
    if (state.coreRegen > 0) {
      state.coreHp = Math.min(state.coreMaxHp, state.coreHp + state.coreRegen * dt);
    }
    if (state.spawnQueue.length > 0) {
      state.spawnTimer -= dt;
      if (state.spawnTimer <= 0) {
        state.spawnTimer = spawnInterval(state.wave);
        spawnFromQueue();
      }
    }
    stepPlayer(dt, control);
    if (state.screen !== SCREEN_PLAY) { particles.update(dt); return; }
    stepBullets(dt);
    stepEnemies(dt);
    if (state.screen !== SCREEN_PLAY) { particles.update(dt); return; }
    stepOrbs(dt);
    stepShards(dt);
    particles.update(dt);
    if (rng.chance(dt * 2)) particles.mote(rng.range(0, VIEW_WIDTH), -4, COLORS.star, rng);
    if (state.spawnQueue.length === 0 && state.enemies.length === 0 && state.screen === SCREEN_PLAY) {
      state.screen = SCREEN_UPGRADE;
      state.upgradesOffered = drawUpgrades(rng);
      state.score += 100 + state.wave * 25;
      emit('waveClear', { wave: state.wave });
    }
  }

  function chooseUpgrade(index) {
    const chosen = state.upgradesOffered[index];
    if (!chosen || state.screen !== SCREEN_UPGRADE) return;
    // Upgrades describe themselves against a merged ship+core stat view.
    const stats = {
      get fireRate() { return state.player.fireRate; }, set fireRate(v) { state.player.fireRate = v; },
      get damage() { return state.player.damage; }, set damage(v) { state.player.damage = v; },
      get projectiles() { return state.player.projectiles; }, set projectiles(v) { state.player.projectiles = v; },
      get moveSpeed() { return state.player.moveSpeed; }, set moveSpeed(v) { state.player.moveSpeed = v; },
      get shieldMax() { return state.player.shieldMax; }, set shieldMax(v) { state.player.shieldMax = v; },
      get shield() { return state.player.shield; }, set shield(v) { state.player.shield = v; },
      get coreMaxHp() { return state.coreMaxHp; }, set coreMaxHp(v) { state.coreMaxHp = v; },
      get coreHp() { return state.coreHp; }, set coreHp(v) { state.coreHp = v; },
      get coreRegen() { return state.coreRegen; }, set coreRegen(v) { state.coreRegen = v; },
      get magnetRadius() { return state.player.magnetRadius; }, set magnetRadius(v) { state.player.magnetRadius = v; },
      get hp() { return state.player.hp; }, set hp(v) { state.player.hp = v; },
      get maxHp() { return state.player.maxHp; }, set maxHp(v) { state.player.maxHp = v; },
      get regen() { return state.player.regen; }, set regen(v) { state.player.regen = v; },
      get pierce() { return state.player.pierce; }, set pierce(v) { state.player.pierce = v; },
    };
    chosen.apply(stats);
    state.upgradesOffered = [];
    state.wave += 1;
    state.screen = SCREEN_PLAY;
    startWave();
    emit('upgrade', { id: chosen.id });
  }

  return { state, particles, rng, startRun, step, chooseUpgrade, emit };
}
