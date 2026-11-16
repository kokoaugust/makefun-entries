// The armoury: five guns and two grenades, each a row of numbers the rest of the game reads.
// Damage falls off with distance, spread is in radians at the muzzle and grows while moving or
// firing, and the head multiplier is what rewards stopping to aim. Prices are what the buy menu
// charges; a weapon's `slot` decides which key draws it.

export const WEAPONS = {
  sidearm: {
    name: 'P9 Sidearm', price: 0, slot: 2, damage: 26, headMult: 3.2, rpm: 320, mag: 12,
    reserve: 48, reloadMs: 1100, spread: 0.011, spreadMove: 0.02, recoil: 0.011,
    range: 42, falloff: 0.45, pellets: 1, auto: false, zoom: 1,
  },
  kestrel: {
    name: 'Kestrel SMG', price: 1250, slot: 1, damage: 21, headMult: 2.6, rpm: 780, mag: 30,
    reserve: 90, reloadMs: 1900, spread: 0.017, spreadMove: 0.026, recoil: 0.008,
    range: 34, falloff: 0.4, pellets: 1, auto: true, zoom: 1,
  },
  breach12: {
    name: 'Breach-12', price: 1100, slot: 1, damage: 13, headMult: 1.6, rpm: 68, mag: 6,
    reserve: 24, reloadMs: 2600, spread: 0.055, spreadMove: 0.03, recoil: 0.05,
    range: 16, falloff: 0.25, pellets: 8, auto: false, zoom: 1,
  },
  vk7: {
    name: 'VK-7 Rifle', price: 2700, slot: 1, damage: 34, headMult: 4, rpm: 600, mag: 30,
    reserve: 90, reloadMs: 2200, spread: 0.008, spreadMove: 0.03, recoil: 0.014,
    range: 70, falloff: 0.65, pellets: 1, auto: true, zoom: 1,
  },
  longbow: {
    name: 'Longbow DMR', price: 3750, slot: 1, damage: 92, headMult: 3, rpm: 52, mag: 6,
    reserve: 24, reloadMs: 2800, spread: 0.0015, spreadMove: 0.05, recoil: 0.06,
    range: 120, falloff: 0.9, pellets: 1, auto: false, zoom: 2.6,
  },
};

export const GRENADES = {
  frag: { name: 'Ember Frag', price: 300, damage: 92, radius: 6.5, fuseMs: 1500 },
  flash: { name: 'Flare Flash', price: 200, radius: 14, fuseMs: 1100 },
};

export const ARMOR_PRICE = 650;

// One actor's carried weapon: which gun, what is in it, and the timers the trigger reads.
// Kept as a plain object the simulation mutates; nothing here knows about meshes or sound.
export function makeLoadout() {
  return {
    primary: null,            // weapon key or null (slot 1)
    secondary: 'sidearm',     // weapon key (slot 2)
    current: 'sidearm',
    mag: WEAPONS.sidearm.mag,
    reserve: WEAPONS.sidearm.reserve,
    armor: 0,                 // 0 or 100
    frag: 0,
    flash: 0,
    nextShotAt: 0,            // ms on the match clock
    reloadEndsAt: 0,          // ms on the match clock, 0 when not reloading
    shotsFired: 0,            // in the current burst, drives spread bloom
  };
}

// Damage at a distance: full inside a third of the range, easing to the falloff floor at range.
export function damageAt(def, distance) {
  const near = def.range / 3;
  if (distance <= near) return def.damage;
  const t = Math.min(1, (distance - near) / (def.range - near));
  return def.damage * (1 - t * (1 - def.falloff));
}

// Total spread for a shot: the gun's base, plus a movement penalty scaled by ground speed,
// plus bloom from the burst so far, all of it shrunk by crouching and aiming down the DMR scope.
export function spreadFor(def, speed, crouched, zoomed, burst) {
  let spread = def.spread + def.spreadMove * Math.min(1, speed / 5.2) + burst * 0.0022;
  if (crouched) spread *= 0.62;
  if (zoomed) spread *= 0.25;
  return spread;
}
