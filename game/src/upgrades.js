// The between-wave upgrade draft: after each cleared wave the player picks 1 of 3.
// Every upgrade stacks, so a long run bends the ship toward the player's choices.

export const UPGRADE_POOL = [
  {
    id: 'rapid', name: 'Rapid Cycler', icon: '»',
    describe: (s) => `Fire rate +22% (now ${Math.round(s.fireRate * 1.22)} shots/s)`,
    apply(s) { s.fireRate *= 1.22; },
  },
  {
    id: 'damage', name: 'Heavy Rounds', icon: '◆',
    describe: (s) => `Bullet damage +6 (now ${s.damage + 6})`,
    apply(s) { s.damage += 6; },
  },
  {
    id: 'multishot', name: 'Split Cannon', icon: '⋔',
    describe: (s) => `+1 projectile per shot (now ${s.projectiles + 1})`,
    apply(s) { s.projectiles += 1; },
  },
  {
    id: 'speed', name: 'Swift Thrusters', icon: '➤',
    describe: (s) => `Move speed +12% (now ${Math.round(s.moveSpeed * 1.12)} u/s)`,
    apply(s) { s.moveSpeed *= 1.12; },
  },
  {
    id: 'shield', name: 'Aegis Shield', icon: '⬡',
    describe: (s) => `Shield +25 max (now ${s.shieldMax + 25}), recharges out of fire`,
    apply(s) { s.shieldMax += 25; s.shield = Math.min(s.shieldMax, s.shield + 25); },
  },
  {
    id: 'plating', name: 'Core Plating', icon: '✚',
    describe: (s) => `Core +60 max hull and repair 60 (now ${s.coreMaxHp + 60})`,
    apply(s) { s.coreMaxHp += 60; s.coreHp = Math.min(s.coreMaxHp, s.coreHp + 60); },
  },
  {
    id: 'magnet', name: 'Magnet Field', icon: '◎',
    describe: (s) => `Shard magnet radius +70 (now ${s.magnetRadius + 70})`,
    apply(s) { s.magnetRadius += 70; },
  },
  {
    id: 'repair', name: 'Repair Nanobots', icon: '♥',
    describe: (s) => `Repair 40 hull now and +1/s regeneration`,
    apply(s) { s.hp = Math.min(s.maxHp, s.hp + 40); s.regen += 1; },
  },
  {
    id: 'pierce', name: 'Piercing Rounds', icon: '➶',
    describe: (s) => `Bullets pierce +1 enemy (now ${s.pierce + 1})`,
    apply(s) { s.pierce += 1; },
  },
  {
    id: 'coreRegen', name: 'Living Core', icon: '❋',
    describe: (s) => `Core regenerates +1.5 hull/s (now ${s.coreRegen + 1.5}/s)`,
    apply(s) { s.coreRegen += 1.5; },
  },
  {
    id: 'vitality', name: 'Reinforced Hull', icon: '⬢',
    describe: (s) => `Ship +25 max hull and repair 25 (now ${s.maxHp + 25})`,
    apply(s) { s.maxHp += 25; s.hp = Math.min(s.maxHp, s.hp + 25); },
  },
];

/** Draw three distinct upgrades for the draft, using the world's seeded random. */
export function drawUpgrades(rng) {
  const bag = [...UPGRADE_POOL];
  const drawn = [];
  for (let i = 0; i < 3; i += 1) {
    const index = Math.floor(rng.next() * bag.length);
    drawn.push(bag.splice(index, 1)[0]);
  }
  return drawn;
}
