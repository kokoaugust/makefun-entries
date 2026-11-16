// The interface: every DOM element the player reads — health, money, ammunition, the clock,
// the killfeed, the buy menu, the scoreboard, banners and the start/pause/end overlays. main.js
// feeds it match state; this file owns no game rules, it only renders what game.js decided.
// Text writes are cached so a steady frame touches the DOM only where a value actually moved.
import { WEAPONS, GRENADES, ARMOR_PRICE } from './weapons.js';
import { CONFIG, timeLeft } from './game.js';

const $ = (id) => document.getElementById(id);

function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const BUY_ITEMS = [
  { id: 'kestrel', key: 'Digit1', label: WEAPONS.kestrel.name, price: WEAPONS.kestrel.price, kind: 'primary' },
  { id: 'breach12', key: 'Digit2', label: WEAPONS.breach12.name, price: WEAPONS.breach12.price, kind: 'primary' },
  { id: 'vk7', key: 'Digit3', label: WEAPONS.vk7.name, price: WEAPONS.vk7.price, kind: 'primary' },
  { id: 'longbow', key: 'Digit4', label: WEAPONS.longbow.name, price: WEAPONS.longbow.price, kind: 'primary' },
  { id: 'armor', key: 'Digit5', label: 'Kevlar Vest', price: ARMOR_PRICE, kind: 'armor' },
  { id: 'frag', key: 'Digit6', label: GRENADES.frag.name, price: GRENADES.frag.price, kind: 'frag' },
  { id: 'flash', key: 'Digit7', label: GRENADES.flash.name, price: GRENADES.flash.price, kind: 'flash' },
];

export function createHud() {
  const els = {
    hud: $('hud'),
    timer: $('timer'),
    phase: $('phase-label'),
    scoreA: $('score-attack'),
    scoreD: $('score-defend'),
    round: $('round-label'),
    health: $('health-value'),
    armor: $('armor-value'),
    money: $('money-value'),
    ammoMag: $('ammo-mag'),
    ammoReserve: $('ammo-reserve'),
    weapon: $('weapon-name'),
    crosshair: $('crosshair'),
    hitmarker: $('hitmarker'),
    killfeed: $('killfeed'),
    banner: $('banner'),
    bannerTitle: $('banner-title'),
    bannerSub: $('banner-sub'),
    buy: $('buymenu'),
    buyItems: $('buy-items'),
    buyMoney: $('buy-money'),
    board: $('scoreboard'),
    boardBody: $('scoreboard-body'),
    channel: $('channel'),
    channelBar: $('channel-bar'),
    channelLabel: $('channel-label'),
    bomb: $('bomb-status'),
    overlay: $('overlay'),
    overlayTitle: $('overlay-title'),
    overlayCopy: $('overlay-copy'),
    play: $('play'),
    flash: $('flash'),
    vignette: $('vignette'),
    spectate: $('spectate'),
    aliveA: $('alive-attack'),
    aliveD: $('alive-defend'),
  };
  const cache = new Map();
  const setText = (el, value) => {
    if (cache.get(el) !== value) {
      cache.set(el, value);
      el.textContent = value;
    }
  };
  let bannerUntil = 0;
  let hitmarkUntil = 0;
  let buyCallback = null;

  // Build the buy menu once; refresh() repaints prices and affordability each frame it is open.
  const itemEls = new Map();
  for (const item of BUY_ITEMS) {
    const button = document.createElement('button');
    button.className = 'buy-item';
    button.type = 'button';
    button.innerHTML = `<span class="buy-key">${item.key.replace('Digit', '')}</span><span class="buy-name"></span><span class="buy-price"></span>`;
    button.addEventListener('click', () => { if (buyCallback) buyCallback(item.id); });
    els.buyItems.appendChild(button);
    itemEls.set(item.id, {
      root: button,
      name: button.querySelector('.buy-name'),
      price: button.querySelector('.buy-price'),
    });
  }

  function owned(player, item) {
    const load = player.loadout;
    if (item.kind === 'primary') return load.primary === item.id;
    if (item.kind === 'armor') return load.armor > 0;
    if (item.kind === 'frag') return load.frag > 0;
    if (item.kind === 'flash') return load.flash > 0;
    return false;
  }

  return {
    els,
    onPlay(fn) { els.play.addEventListener('click', fn); },
    setBuyCallback(fn) { buyCallback = fn; },

    update(match, player, nowMs) {
      const left = timeLeft(match);
      setText(els.timer, formatClock(left));
      els.timer.classList.toggle('urgent', match.phase === 'live' && left < 11000 && match.bomb.state !== 'planted');
      setText(els.phase, match.phase === 'buy' ? 'BUY PHASE' : match.bomb.state === 'planted' ? 'CHARGE PLANTED' : match.phase === 'live' ? `ROUND ${match.round}` : match.phase === 'over' ? 'ROUND OVER' : 'MATCH OVER');
      setText(els.scoreA, String(match.score.attack));
      setText(els.scoreD, String(match.score.defend));
      setText(els.round, `Round ${match.round} / ${CONFIG.maxRounds} · first to ${CONFIG.roundsToWin}`);
      const aliveA = match.actors.filter((a) => a.team === 'attack' && a.alive).length;
      const aliveD = match.actors.filter((a) => a.team === 'defend' && a.alive).length;
      setText(els.aliveA, '●'.repeat(aliveA));
      setText(els.aliveD, '●'.repeat(aliveD));

      setText(els.health, String(Math.max(0, Math.ceil(player.health))));
      els.health.classList.toggle('low', player.health <= 30);
      setText(els.armor, player.loadout.armor > 0 ? `🛡 ${Math.ceil(player.loadout.armor)}` : '');
      setText(els.money, `$${player.money}`);
      const def = WEAPONS[player.loadout.current];
      setText(els.weapon, def.name + (player.loadout.reloadEndsAt > match.now ? ' — reloading' : ''));
      setText(els.ammoMag, String(player.loadout.mag));
      setText(els.ammoReserve, `/ ${player.loadout.reserve}`);
      els.ammoMag.classList.toggle('empty', player.loadout.mag === 0);

      // Killfeed: rebuilt only when its head changes.
      const feedKey = match.killfeed.length ? `${match.killfeed[0].at}:${match.killfeed.length}` : 'none';
      if (cache.get('feed') !== feedKey) {
        cache.set('feed', feedKey);
        els.killfeed.innerHTML = match.killfeed
          .map((entry) => `<div class="feed ${entry.team ?? ''}">${entry.text}</div>`)
          .join('');
      }

      // The planted-charge readout.
      if (match.bomb.state === 'planted') {
        els.bomb.hidden = false;
        setText(els.bomb, `⚠ CHARGE PLANTED — SITE ${match.bomb.site.id} · ${formatClock(match.bomb.detonateAt - match.now)}`);
      } else if (player.hasBomb) {
        els.bomb.hidden = false;
        setText(els.bomb, `◆ You carry the charge — plant it at site ${match.siteTarget.id}`);
      } else if (match.bomb.state === 'dropped') {
        els.bomb.hidden = false;
        setText(els.bomb, '◆ The charge is down');
      } else {
        els.bomb.hidden = true;
      }

      // Channel progress (planting / defusing).
      const channel = match.channels.get(player.id);
      if (channel) {
        els.channel.hidden = false;
        const span = channel.endsAt - channel.startedAt;
        const done = Math.min(1, (match.now - channel.startedAt) / span);
        els.channelBar.style.width = `${Math.round(done * 100)}%`;
        setText(els.channelLabel, channel.kind === 'plant' ? 'PLANTING THE CHARGE…' : 'DEFUSING…');
      } else {
        els.channel.hidden = true;
      }

      if (nowMs > bannerUntil) els.banner.hidden = true;
      if (nowMs > hitmarkUntil) els.hitmarker.classList.remove('on');
      els.spectate.hidden = player.alive || match.phase === 'matchover';
    },

    setCrosshairGap(px) {
      els.crosshair.style.setProperty('--gap', `${Math.round(px)}px`);
    },
    hitmarker(kill, nowMs) {
      els.hitmarker.classList.add('on');
      els.hitmarker.classList.toggle('kill', kill);
      hitmarkUntil = nowMs + (kill ? 240 : 110);
    },
    banner(title, sub, nowMs, holdMs = 2600) {
      els.bannerTitle.textContent = title;
      els.bannerSub.textContent = sub ?? '';
      els.banner.hidden = false;
      bannerUntil = nowMs + holdMs;
    },
    flashScreen(strength) {
      els.flash.style.opacity = String(Math.min(1, strength));
      requestAnimationFrame(() => {
        els.flash.style.transition = 'opacity 2.4s ease-out';
        els.flash.style.opacity = '0';
        setTimeout(() => { els.flash.style.transition = ''; }, 2500);
      });
    },
    hurtFlash() {
      els.vignette.classList.add('on');
      setTimeout(() => els.vignette.classList.remove('on'), 130);
    },

    showBuy(player) {
      els.buy.hidden = false;
      this.refreshBuy(player);
    },
    hideBuy() { els.buy.hidden = true; },
    buyOpen() { return !els.buy.hidden; },
    refreshBuy(player) {
      setText(els.buyMoney, `$${player.money}`);
      for (const item of BUY_ITEMS) {
        const view = itemEls.get(item.id);
        const has = owned(player, item);
        view.name.textContent = item.label + (has ? ' ✓' : '');
        view.price.textContent = `$${item.price}`;
        view.root.disabled = has || player.money < item.price;
        view.root.classList.toggle('owned', has);
      }
    },

    showScoreboard(match) {
      const rows = [...match.actors].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
      els.boardBody.innerHTML = rows.map((a) => (
        `<tr class="${a.team}${a.isPlayer ? ' me' : ''}${a.alive ? '' : ' dead'}"><td>${a.isPlayer ? 'You' : a.name}</td><td>${a.team === 'attack' ? 'Ember' : 'Watch'}</td><td>${a.kills}</td><td>${a.deaths}</td><td>$${a.money}</td><td>${a.alive ? 'alive' : 'down'}</td></tr>`
      )).join('');
      els.board.hidden = false;
    },
    hideScoreboard() { els.board.hidden = true; },

    showOverlay(mode, match) {
      els.overlay.hidden = false;
      if (mode === 'start') {
        els.overlayTitle.textContent = 'Emberline Depot';
        els.overlayCopy.textContent = 'Five on five at the freight yard. Plant the breach charge at the North Silo or the South Dock — or stop the other side from doing it. First to 7 rounds.';
        els.play.textContent = 'Click to play';
      } else if (mode === 'pause') {
        els.overlayTitle.textContent = 'Paused';
        els.overlayCopy.textContent = `Round ${match.round} — Ember ${match.score.attack} : ${match.score.defend} Watch. Click to keep playing.`;
        els.play.textContent = 'Resume';
      } else if (mode === 'matchover') {
        const won = match.matchWinner === 'attack';
        els.overlayTitle.textContent = match.matchWinner ? (won ? 'Emberline is yours' : 'The Watch holds the yard') : 'Dead even';
        els.overlayCopy.textContent = `Final score — Ember ${match.score.attack} : ${match.score.defend} Watch. You finished with ${match.player.kills} kills and ${match.player.deaths} deaths.`;
        els.play.textContent = 'Play again';
      }
    },
    hideOverlay() { els.overlay.hidden = true; },
  };
}
