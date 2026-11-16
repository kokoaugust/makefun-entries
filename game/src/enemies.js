// The enemy bestiary: five kinds with distinct silhouettes and behaviours, plus the boss.
// Chasers and tanks march on the core, splitters burst into minis when killed, dashers hunt
// the player ship itself, and every fifth wave the Dreadnought arrives.

export const KIND_CHASER = 'chaser';
export const KIND_MINI = 'mini';
export const KIND_TANK = 'tank';
export const KIND_SPLITTER = 'splitter';
export const KIND_DASHER = 'dasher';
export const KIND_BOSS = 'boss';

const BASE_STATS = {
  [KIND_CHASER]: { hp: 22, speed: 92, radius: 13, coreDamage: 8, contactDamage: 10, score: 50 },
  [KIND_MINI]: { hp: 9, speed: 138, radius: 8, coreDamage: 4, contactDamage: 6, score: 25 },
  [KIND_TANK]: { hp: 130, speed: 42, radius: 26, coreDamage: 26, contactDamage: 16, score: 150 },
  [KIND_SPLITTER]: { hp: 44, speed: 66, radius: 18, coreDamage: 12, contactDamage: 12, score: 100 },
  [KIND_DASHER]: { hp: 30, speed: 118, radius: 12, coreDamage: 8, contactDamage: 14, score: 100 },
  [KIND_BOSS]: { hp: 1500, speed: 26, radius: 52, coreDamage: 60, contactDamage: 24, score: 2000 },
};

let nextId = 1;

export function createEnemy(kind, x, y, wave) {
  const base = BASE_STATS[kind];
  const hpMul = kind === KIND_BOSS ? 1 + (wave / 5 - 1) * 0.6 : 1 + (wave - 1) * 0.16;
  const hp = Math.round(base.hp * hpMul);
  return {
    id: nextId++,
    kind,
    x, y, vx: 0, vy: 0,
    hp, maxHp: hp,
    radius: base.radius,
    speed: base.speed,
    coreDamage: base.coreDamage,
    contactDamage: base.contactDamage,
    score: base.score,
    angle: 0,
    hitFlash: 0,
    knockX: 0, knockY: 0,
    mode: 'approach',
    modeTimer: 0,
    dashX: 0, dashY: 0,
    spawnTimer: 2.2,
    orbTimer: 3.2,
    // A golden-angle hash of the id: varied per enemy, yet fully deterministic, so a
    // seeded run (and a staged screenshot scene) replays exactly.
    wobble: (nextId * 2.39996) % (Math.PI * 2),
  };
}

/** The spawn queue for a wave: a shuffled list of kinds, bosses on every fifth wave. */
export function wavePlan(wave, rng) {
  const plan = [];
  if (wave % 5 === 0) {
    plan.push(KIND_BOSS);
    const escorts = 4 + wave;
    for (let i = 0; i < escorts; i += 1) plan.push(rng.chance(0.6) ? KIND_CHASER : KIND_DASHER);
    return plan;
  }
  const total = 6 + wave * 3;
  for (let i = 0; i < total; i += 1) {
    const roll = rng.next();
    if (wave >= 2 && roll < 0.16) plan.push(KIND_SPLITTER);
    else if (wave >= 3 && roll < 0.30) plan.push(KIND_DASHER);
    else if (wave >= 4 && roll < 0.40) plan.push(KIND_TANK);
    else plan.push(KIND_CHASER);
  }
  // Shuffle so kinds arrive mixed rather than in blocks.
  rng.shuffle(plan);
  if (plan[0] === KIND_TANK) plan.push(plan.shift());
  return plan;
}

/** Seconds between spawns; waves arrive faster as they grow. */
export function spawnInterval(wave) {
  return Math.max(0.45, 1.15 - wave * 0.06);
}

function steer(e, targetX, targetY, speed, dt) {
  const dx = targetX - e.x;
  const dy = targetY - e.y;
  const dist = Math.hypot(dx, dy) || 1;
  e.vx = (dx / dist) * speed;
  e.vy = (dy / dist) * speed;
  e.x += e.vx * dt;
  e.y += e.vy * dt;
  e.angle = Math.atan2(e.vy, e.vx);
}

/**
 * Advance one enemy. ctx carries the player position, the core position and the world's
 * callbacks for the boss's minion spawns and orb shots.
 */
export function updateEnemy(e, ctx, dt) {
  e.hitFlash = Math.max(0, e.hitFlash - dt * 6);
  // Knockback from bullet hits decays fast and rides on top of steering.
  e.x += e.knockX * dt;
  e.y += e.knockY * dt;
  e.knockX *= Math.max(0, 1 - 9 * dt);
  e.knockY *= Math.max(0, 1 - 9 * dt);
  e.wobble += dt * 3;

  switch (e.kind) {
    case KIND_DASHER: {
      const dx = ctx.playerX - e.x;
      const dy = ctx.playerY - e.y;
      const dist = Math.hypot(dx, dy) || 1;
      e.modeTimer -= dt;
      if (e.mode === 'approach') {
        steer(e, ctx.playerX, ctx.playerY, e.speed, dt);
        if (dist < 250 && e.modeTimer <= 0) {
          e.mode = 'windup';
          e.modeTimer = 0.45;
        }
      } else if (e.mode === 'windup') {
        e.vx = 0; e.vy = 0;
        e.angle = Math.atan2(dy, dx);
        if (e.modeTimer <= 0) {
          e.mode = 'dash';
          e.modeTimer = 0.34;
          e.dashX = (dx / dist) * 560;
          e.dashY = (dy / dist) * 560;
        }
      } else if (e.mode === 'dash') {
        e.x += e.dashX * dt;
        e.y += e.dashY * dt;
        e.angle = Math.atan2(e.dashY, e.dashX);
        if (e.modeTimer <= 0) {
          e.mode = 'approach';
          e.modeTimer = 0.7;
        }
      }
      break;
    }
    case KIND_BOSS: {
      steer(e, ctx.coreX, ctx.coreY, e.speed, dt);
      e.spawnTimer -= dt;
      if (e.spawnTimer <= 0) {
        e.spawnTimer = 3.4;
        ctx.onBossSpawn(e);
      }
      e.orbTimer -= dt;
      if (e.orbTimer <= 0) {
        e.orbTimer = 2.6;
        ctx.onBossOrbs(e);
      }
      break;
    }
    default: {
      // Chasers, minis, tanks and splitters make for the core, with a slight wobble so
      // a pack does not march in a single file line.
      const wob = Math.sin(e.wobble) * 14;
      steer(e, ctx.coreX - Math.sin(e.wobble * 0.7) * wob, ctx.coreY + Math.cos(e.wobble * 0.7) * wob, e.speed, dt);
    }
  }
}

export function isBoss(e) {
  return e.kind === KIND_BOSS;
}
