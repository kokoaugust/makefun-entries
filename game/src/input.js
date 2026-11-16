// Keyboard and mouse state for the twin-stick controls: WASD or arrows to fly, the mouse
// to aim, hold the button (or Space) to fire. The world reads plain fields, never events.

export function createInput(canvas) {
  const input = {
    moveX: 0,
    moveY: 0,
    aimX: 0,
    aimY: 0,
    firing: false,
    keysDown: new Set(),
    pressed: new Set(),
    mouseClicked: false,
    mouseX: 0,
    mouseY: 0,
  };

  const MOVE_KEYS = {
    KeyW: 'up', ArrowUp: 'up',
    KeyS: 'down', ArrowDown: 'down',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right',
  };

  function recomputeMove() {
    const down = input.keysDown;
    input.moveX = (down.has('right') ? 1 : 0) - (down.has('left') ? 1 : 0);
    input.moveY = (down.has('down') ? 1 : 0) - (down.has('up') ? 1 : 0);
    const length = Math.hypot(input.moveX, input.moveY);
    if (length > 0) {
      input.moveX /= length;
      input.moveY /= length;
    }
  }

  window.addEventListener('keydown', (event) => {
    const move = MOVE_KEYS[event.code];
    if (move) {
      input.keysDown.add(move);
      recomputeMove();
      event.preventDefault();
    }
    if (event.code === 'Space') input.firing = true;
    if (!event.repeat) input.pressed.add(event.code);
  });
  window.addEventListener('keyup', (event) => {
    const move = MOVE_KEYS[event.code];
    if (move) {
      input.keysDown.delete(move);
      recomputeMove();
    }
    if (event.code === 'Space') input.firing = false;
  });
  window.addEventListener('blur', () => {
    input.keysDown.clear();
    input.firing = false;
    recomputeMove();
  });

  function toWorld(event) {
    const rect = canvas.getBoundingClientRect();
    input.mouseX = ((event.clientX - rect.left) / rect.width) * canvas.width;
    input.mouseY = ((event.clientY - rect.top) / rect.height) * canvas.height;
  }
  canvas.addEventListener('mousemove', toWorld);
  canvas.addEventListener('mousedown', (event) => {
    toWorld(event);
    if (event.button === 0) {
      input.firing = true;
      input.mouseClicked = true;
    }
  });
  window.addEventListener('mouseup', (event) => {
    if (event.button === 0) input.firing = false;
  });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  /** End-of-frame bookkeeping: one-shot presses and clicks live for exactly one frame. */
  input.endFrame = () => {
    input.pressed.clear();
    input.mouseClicked = false;
  };

  return input;
}
