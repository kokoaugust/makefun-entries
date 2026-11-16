// Keyboard and mouse state for the human player, and the pointer-lock plumbing around them.
// The simulation reads `state` and drains mouse movement with takeLook(); nothing here knows
// what the keys mean, which keeps the bindings in one place (game.js maps them to actions).

export function createInput(canvas, onLockChange) {
  const keys = new Set();
  const pressed = new Set();   // keys that went down since the last drain (for menus, buys)
  let lookX = 0;
  let lookY = 0;
  let firing = false;
  let aiming = false;

  const state = {
    keys,
    get firing() { return firing; },
    get aiming() { return aiming; },
    get locked() { return document.pointerLockElement === canvas; },
  };

  window.addEventListener('keydown', (event) => {
    if (event.repeat) return;
    keys.add(event.code);
    pressed.add(event.code);
    if (event.code === 'Space') event.preventDefault();
  });
  window.addEventListener('keyup', (event) => keys.delete(event.code));
  window.addEventListener('blur', () => { keys.clear(); firing = false; aiming = false; });

  canvas.addEventListener('mousedown', (event) => {
    if (!state.locked) return;
    if (event.button === 0) firing = true;
    if (event.button === 2) aiming = true;
  });
  window.addEventListener('mouseup', (event) => {
    if (event.button === 0) firing = false;
    if (event.button === 2) aiming = false;
  });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  document.addEventListener('pointerlockchange', () => {
    if (!state.locked) { firing = false; aiming = false; }
    onLockChange(state.locked);
  });
  document.addEventListener('mousemove', (event) => {
    if (!state.locked) return;
    lookX += event.movementX || 0;
    lookY += event.movementY || 0;
  });

  return {
    state,
    takeLook() {
      const taken = { x: lookX, y: lookY };
      lookX = 0;
      lookY = 0;
      return taken;
    },
    // One-shot key presses since the last call, for the buy menu and weapon slots.
    takePressed() {
      const taken = new Set(pressed);
      pressed.clear();
      return taken;
    },
    requestLock() {
      canvas.requestPointerLock();
    },
  };
}
