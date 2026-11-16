// Hitscan resolution, shared by the player's trigger and every bot's: cast one ray, find the
// nearest thing it meets — a wall, a head, a body — and price the damage with distance falloff
// and the head multiplier. Nothing here mutates health; the caller applies the result through
// game.js so kills, money and the killfeed are decided in exactly one place.
import { hitboxes } from './actors.js';
import { raycastWorld } from './world.js';
import { damageAt } from './weapons.js';

function raySphere(ox, oy, oz, dx, dy, dz, s) {
  const cx = s.x - ox;
  const cy = s.y - oy;
  const cz = s.z - oz;
  const along = cx * dx + cy * dy + cz * dz;
  if (along < 0) return Infinity;
  const distSq = cx * cx + cy * cy + cz * cz - along * along;
  const rSq = s.r * s.r;
  if (distSq > rSq) return Infinity;
  return along - Math.sqrt(rSq - distSq);
}

function rayBody(ox, oy, oz, dx, dy, dz, b) {
  let tmin = 0;
  let tmax = Infinity;
  const axes = [
    [ox, dx, b.minX, b.maxX],
    [oy, dy, b.base, b.top],
    [oz, dz, b.minZ, b.maxZ],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return Infinity;
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return Infinity;
    }
  }
  return tmin;
}

// Fire one pellet. origin/dir are THREE.Vector3 (dir normalised). Returns null on a clean
// miss into the sky, else { victim|null, part, damage, distance, point } where a null victim
// means the pellet stopped in scenery at `distance`.
export function firePellet(shooter, origin, dir, def, actors, point) {
  const wallDist = raycastWorld(origin, dir, 160);
  let victim = null;
  let part = 'body';
  let best = wallDist;
  for (const other of actors) {
    if (other === shooter || !other.alive || other.team === shooter.team) continue;
    const boxes = hitboxes(other);
    const headT = raySphere(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, boxes.head);
    if (headT < best) {
      best = headT;
      victim = other;
      part = 'head';
      continue;
    }
    const bodyT = rayBody(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, boxes.body);
    if (bodyT < best) {
      best = bodyT;
      victim = other;
      part = 'body';
    }
  }
  if (best === Infinity) return null;
  point.copy(dir).multiplyScalar(best).add(origin);
  if (!victim) return { victim: null, part: 'wall', damage: 0, distance: best, point };
  let damage = damageAt(def, best);
  if (part === 'head') damage *= def.headMult;
  return { victim, part, damage, distance: best, point };
}

// Armour soaks two thirds of a hit and wears down by what it soaks.
export function applyArmor(victim, damage) {
  const load = victim.loadout;
  if (load.armor <= 0) return damage;
  const soaked = Math.min(load.armor, damage * 0.66);
  load.armor -= soaked;
  return damage - soaked;
}
