// Bot brains: perception, pathing and decisions for the nine fighters who are not the player.
// A bot thinks a few times a second (staggered, so they never all think on the same tick) and
// steers every tick. It walks the waypoint graph from mapdata.js with breadth-first paths,
// stops to shoot (spread punishes movement, for bots as much as for the player), works the
// objective — the carrier plants, a defender defuses — and buys its own gear each round.
import { NODES, EDGES, COVER } from './mapdata.js';
import { lineOfSight } from './world.js';
import { WEAPONS } from './weapons.js';

const ADJ = NODES.map(() => []);
for (const [a, b] of EDGES) {
  ADJ[a].push(b);
  ADJ[b].push(a);
}

export function nearestNode(x, z) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < NODES.length; i += 1) {
    const d = (NODES[i][0] - x) ** 2 + (NODES[i][1] - z) ** 2;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

// Breadth-first shortest path over the waypoint graph, as a list of node indices.
export function findPath(fromNode, toNode) {
  if (fromNode === toNode) return [fromNode];
  const prev = new Array(NODES.length).fill(-1);
  const queue = [fromNode];
  prev[fromNode] = fromNode;
  while (queue.length) {
    const node = queue.shift();
    for (const next of ADJ[node]) {
      if (prev[next] !== -1) continue;
      prev[next] = node;
      if (next === toNode) {
        const path = [toNode];
        let cursor = toNode;
        while (cursor !== fromNode) {
          cursor = prev[cursor];
          path.unshift(cursor);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return [fromNode];
}

const _eye = { x: 0, y: 0, z: 0 };
const _chest = { x: 0, y: 0, z: 0 };

export function createBrain(actor, skill) {
  return {
    skill,                    // 0..1: reaction time and aim error derive from it
    path: [],
    pathI: 0,
    goal: null,               // { x, z } final destination
    goalNode: -1,
    enemy: null,
    enemySeenAt: 0,
    lastSeenPos: null,
    lastSeenAt: -1e9,
    alertPos: null,           // heard something here
    nextThinkAt: Math.random() * 150,
    nextShotAt: 0,
    burstLeft: 0,
    strafeUntil: 0,
    strafeDir: 1,
    holdPos: null,            // assigned cover point when holding
    holdUntil: 0,
    scanYaw: actor.yaw,
    channelWanted: null,      // 'plant' | 'defuse' | null, read by game.js
  };
}

function canSee(bot, other, now) {
  if (bot.flashUntil > now) return false;   // a flashed bot sees nothing until it clears
  _eye.x = bot.pos.x;
  _eye.y = bot.pos.y + (bot.crouched ? 1.06 : 1.62);
  _eye.z = bot.pos.z;
  _chest.x = other.pos.x;
  _chest.y = other.pos.y + 1.15;
  _chest.z = other.pos.z;
  const dx = _chest.x - _eye.x;
  const dz = _chest.z - _eye.z;
  const dist = Math.hypot(dx, _chest.y - _eye.y, dz);
  if (dist > 68) return false;
  // Field of view: 150 degrees, unless the enemy is close enough to be felt, or already tracked.
  const flatDist = Math.hypot(dx, dz) || 1;
  const facingX = -Math.sin(bot.yaw);
  const facingZ = -Math.cos(bot.yaw);
  const dot = (dx * facingX + dz * facingZ) / flatDist;
  if (dot < -0.25 && dist > 7 && bot.brain.enemy !== other) return false;
  return lineOfSight(_eye, _chest);
}

function setGoal(bot, x, z) {
  const brain = bot.brain;
  const toNode = nearestNode(x, z);
  if (brain.goalNode === toNode && brain.goal && brain.goal.x === x && brain.goal.z === z) return;
  brain.goal = { x, z };
  brain.goalNode = toNode;
  brain.path = findPath(nearestNode(bot.pos.x, bot.pos.z), toNode);
  brain.pathI = 0;
}

// The think step: perception first, then a decision about where to be and what to do.
// ctx is the match context game.js hands down: { now, actors, bomb, siteTarget, fireAt }.
function think(bot, ctx) {
  const brain = bot.brain;
  const now = ctx.now;

  // Perception: the nearest visible enemy becomes the tracked enemy.
  let visible = null;
  let visibleDist = Infinity;
  for (const other of ctx.actors) {
    if (!other.alive || other.team === bot.team) continue;
    if (canSee(bot, other, now)) {
      const d = bot.pos.distanceTo(other.pos);
      if (d < visibleDist) { visibleDist = d; visible = other; }
    }
  }
  if (visible) {
    if (brain.enemy !== visible) brain.enemySeenAt = now;
    brain.enemy = visible;
    brain.lastSeenPos = { x: visible.pos.x, z: visible.pos.z };
    brain.lastSeenAt = now;
    brain.alertPos = null;
  } else if (brain.enemy && (!brain.enemy.alive || now - brain.lastSeenAt > 4200)) {
    brain.enemy = null;
  }
  // Hearing: a recent shot near an unseen spot pulls the bot's attention there.
  if (!visible && ctx.lastShot && ctx.lastShot.team !== bot.team && now - ctx.lastShot.at < 2600) {
    const d = Math.hypot(ctx.lastShot.x - bot.pos.x, ctx.lastShot.z - bot.pos.z);
    if (d < 30) brain.alertPos = { x: ctx.lastShot.x, z: ctx.lastShot.z };
  }

  brain.channelWanted = null;
  const bomb = ctx.bomb;

  // A frag for a corner the enemy was just seen behind: thrown on the way in, not every think.
  if (ctx.throwGrenadeAt && bot.loadout.frag > 0 && brain.lastSeenPos
      && now - brain.lastSeenAt < 1500 && now > (brain.grenadeAt ?? 0)) {
    const d = Math.hypot(brain.lastSeenPos.x - bot.pos.x, brain.lastSeenPos.z - bot.pos.z);
    if (d > 8 && d < 23 && Math.random() < 0.4) {
      brain.grenadeAt = now + 20000;
      ctx.throwGrenadeAt(bot, brain.lastSeenPos);
    }
  }

  // Objective decisions, highest first.
  if (bomb.state === 'planted') {
    const site = bomb.site;
    if (bot.team === 'defend') {
      const dist = Math.hypot(bot.pos.x - bomb.pos.x, bot.pos.z - bomb.pos.z);
      if (ctx.defuserId === bot.id && dist < 2.2 && !visible) {
        brain.channelWanted = 'defuse';
        brain.goal = null;
        return;
      }
      if (ctx.defuserId === bot.id) setGoal(bot, bomb.pos.x, bomb.pos.z);
      else setGoal(bot, site.x + (bot.id % 3 - 1) * 3, site.z + (bot.id % 2 ? 3 : -3));
      return;
    }
    // Attackers guard the planted charge from cover near the site.
    if (!brain.holdPos || brain.holdPos.site !== site.id) {
      const spots = COVER[site.id];
      brain.holdPos = { x: spots[bot.id % spots.length][0], z: spots[bot.id % spots.length][1], site: site.id };
    }
    setGoal(bot, brain.holdPos.x, brain.holdPos.z);
    return;
  }

  if (bot.hasBomb) {
    const site = ctx.siteTarget;
    const dist = Math.hypot(bot.pos.x - site.x, bot.pos.z - site.z);
    if (dist < site.radius - 1.2 && !visible) {
      brain.channelWanted = 'plant';
      brain.goal = null;
      return;
    }
    setGoal(bot, site.x, site.z);
    return;
  }

  if (bomb.state === 'dropped' && bot.team === 'attack' && ctx.carrierHopefulId === bot.id) {
    setGoal(bot, bomb.pos.x, bomb.pos.z);
    return;
  }

  if (brain.enemy && now - brain.lastSeenAt < 4200) {
    // Hunt the last known position when the target breaks sight.
    if (!visible) setGoal(bot, brain.lastSeenPos.x, brain.lastSeenPos.z);
    return;
  }
  if (brain.alertPos) {
    setGoal(bot, brain.alertPos.x, brain.alertPos.z);
    return;
  }

  // Default duties: attackers push their site, defenders take their posts.
  if (bot.team === 'attack') {
    const site = ctx.siteTarget;
    if (bot.brain.role === 'mid') setGoal(bot, COVER.mid[bot.id % COVER.mid.length][0], COVER.mid[bot.id % COVER.mid.length][1]);
    else setGoal(bot, site.x + (bot.id % 3 - 1) * 2.5, site.z + (bot.id % 2 ? 2.5 : -2.5));
  } else {
    if (!brain.holdPos) {
      const posts = bot.brain.role === 'A' ? COVER.A : bot.brain.role === 'B' ? COVER.B : COVER.mid;
      brain.holdPos = { x: posts[bot.id % posts.length][0], z: posts[bot.id % posts.length][1] };
    }
    setGoal(bot, brain.holdPos.x, brain.holdPos.z);
  }
}

// The per-tick step: steer along the path, fight when there is a target. Returns the wish
// direction and flags actors.js/game.js consume: { wish, jump, crouch, speed }.
const _wish = { x: 0, z: 0 };
export function stepBot(bot, dt, ctx) {
  const brain = bot.brain;
  const now = ctx.now;
  if (now >= brain.nextThinkAt) {
    brain.nextThinkAt = now + 110 + (bot.id % 5) * 17;
    think(bot, ctx);
  }
  _wish.x = 0;
  _wish.z = 0;
  let maxSpeed = 5.2;
  let wantCrouch = false;

  const enemy = brain.enemy && brain.enemy.alive && now - brain.lastSeenAt < 900 ? brain.enemy : null;
  const reactionMs = 480 - brain.skill * 260;
  const engaged = enemy && now - brain.enemySeenAt > reactionMs && canSee(bot, enemy, now);

  if (brain.channelWanted) {
    bot.yaw = brain.scanYaw;
    return { wish: _wish, jump: false, crouch: true, speed: 0 };
  }

  if (engaged) {
    // Face the target, plant the feet (spread is honest), strafe between bursts.
    const dx = enemy.pos.x - bot.pos.x;
    const dz = enemy.pos.z - bot.pos.z;
    bot.yaw = Math.atan2(-dx, -dz);
    bot.pitch = 0;
    if (now > brain.strafeUntil) {
      brain.strafeUntil = now + 500 + Math.random() * 700;
      brain.strafeDir = Math.random() < 0.5 ? -1 : 1;
      brain.burstLeft = 2 + Math.floor(Math.random() * 4);
    }
    const dist = Math.hypot(dx, dz);
    if (dist > 26) {
      _wish.x = dx / dist;
      _wish.z = dz / dist;
      maxSpeed = 4.4;
    } else if (brain.burstLeft <= 0) {
      // Strafe perpendicular to the facing while the burst resets.
      _wish.x = Math.cos(bot.yaw) * brain.strafeDir;
      _wish.z = -Math.sin(bot.yaw) * brain.strafeDir;
      maxSpeed = 2.4;
    }
    if (now >= brain.nextShotAt) {
      const def = WEAPONS[bot.loadout.current];
      brain.nextShotAt = now + (60000 / def.rpm) * (brain.burstLeft > 0 ? 1 : 2.6);
      if (brain.burstLeft > 0) brain.burstLeft -= 1;
      ctx.fireAt(bot, enemy);
    }
    bot.crouched = bot.loadout.current === 'longbow' && dist > 18;
    return { wish: _wish, jump: false, crouch: bot.crouched, speed: maxSpeed };
  }

  // Travel: follow the path, then the goal point itself.
  let target = null;
  if (brain.path && brain.pathI < brain.path.length) {
    const node = NODES[brain.path[brain.pathI]];
    target = { x: node[0], z: node[1] };
    if (Math.hypot(target.x - bot.pos.x, target.z - bot.pos.z) < 1.1) {
      brain.pathI += 1;
      target = null;
    }
  }
  if (!target && brain.goal) target = brain.goal;
  if (target) {
    const dx = target.x - bot.pos.x;
    const dz = target.z - bot.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.55) {
      _wish.x = dx / dist;
      _wish.z = dz / dist;
      bot.yaw = Math.atan2(-dx, -dz);
      // Slow near a hold post so the arrival reads as taking a position, not overshooting.
      if (brain.holdPos && brain.goal === brain.holdPos) maxSpeed = 4.2;
    } else if (brain.holdPos && brain.goal === brain.holdPos) {
      // Holding: slow scan across the lane the post watches.
      brain.scanYaw += Math.sin(now / 1600 + bot.id) * 0.0035;
      bot.yaw = brain.scanYaw;
      wantCrouch = bot.id % 2 === 0;
    }
  }
  bot.crouched = wantCrouch;
  return { wish: _wish, jump: false, crouch: wantCrouch, speed: maxSpeed };
}

// The buy policy: a rifle and armour when rich, an SMG when not, a frag with the change.
// Mutates the loadout and money; game.js calls it for every bot at the start of the buy phase.
export function botBuy(bot) {
  const load = bot.loadout;
  const buy = (key) => {
    const def = WEAPONS[key];
    if (bot.money < def.price) return false;
    bot.money -= def.price;
    if (def.slot === 1) load.primary = key;
    else load.secondary = key;
    load.current = key;
    load.mag = def.mag;
    load.reserve = def.reserve;
    return true;
  };
  if (!load.primary) {
    if (bot.money >= WEAPONS.vk7.price + 650) buy('vk7');
    else if (bot.money >= WEAPONS.longbow.price && bot.brain.role === 'mid') buy('longbow');
    else if (bot.money >= WEAPONS.kestrel.price) buy('kestrel');
    else if (bot.money >= WEAPONS.breach12.price && bot.brain.role !== 'mid') buy('breach12');
  } else {
    load.current = load.primary;
    load.mag = WEAPONS[load.primary].mag;
    load.reserve = WEAPONS[load.primary].reserve;
  }
  if (load.armor === 0 && bot.money >= 650 && (load.primary || bot.money > 1400)) {
    bot.money -= 650;
    load.armor = 100;
  }
  if (load.frag === 0 && bot.money >= 1100) {
    bot.money -= 300;
    load.frag = 1;
  }
  if (load.flash === 0 && bot.money >= 900) {
    bot.money -= 200;
    load.flash = 1;
  }
}
