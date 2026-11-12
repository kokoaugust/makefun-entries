// btc-race-24h bot: rare-thrust momentum on cbBTC/USDC 1-minute bars.
//
// Speaks agent-fun/bars-replay/v1 (newline-delimited JSON on stdin/stdout)
// with a small hand-written client. Deterministic: pure arithmetic on the
// bars received, no randomness, no clock, no network.
//
// Strategy, tuned on the published dev window against the replay's own cost
// model (4 bps fee + 2 bps slippage + constant-product impact, about 27 bps
// for a full-size round trip): minute noise whipsaws ordinary trend and
// mean-reversion systems to death at those costs, so the bot stays in cash
// and trades only a genuine thrust - a rise of at least +0.50% over the
// last 15 minutes - then holds for 120 minutes or bails on a -1.5% disaster
// stop. One position at a time, 95% of cash, 60-minute cooldown after exit.
// Verified on the dev window with the kit's own grader: +2.80 USDC net,
// 2 trades, byte-for-byte reproducible across the two grading executions.
import * as readline from "node:readline";

const ROC_BARS = 15; // thrust lookback, in bars
const ROC_MIN = 1.005; // +0.50% over the lookback
const HOLD_BARS = 120; // exit this many batches after the entry decision
const STOP = 0.985; // disaster stop: -1.5% from the entry close
const COOLDOWN = 60; // batches to sit out after an exit
const SIZE_FRAC = 0.95; // share of cash per entry; the rest stays as buffer
const MAX_SLIP_BPS = 150; // reject fills further than this from the last close

let symbol = "";
let closes: number[] = []; // raw integer closes of the traded symbol
let entryClose: number | null = null;
let heldBatches = 0;
let cooldown = 0;
let orderN = 0;

function onBatch(msg: any): any[] {
  const account = msg.account;
  const cash = Number(account.cash_quote_units);
  let heldQty = "0";
  for (const pos of account.positions) {
    if (pos.symbol === symbol) heldQty = pos.qty;
  }
  const holding = BigInt(heldQty) > 0n;

  let bar: any = null;
  for (const b of msg.bars) {
    if (b.symbol === symbol) bar = b;
  }
  if (bar !== null) closes.push(Number(bar.c));

  const orders: any[] = [];
  if (holding) {
    heldBatches += 1;
    if (entryClose !== null && bar !== null) {
      const last = closes[closes.length - 1];
      if (heldBatches >= HOLD_BARS || last <= entryClose * STOP) {
        orderN += 1;
        orders.push({
          side: "sell",
          client_id: `s${orderN}`,
          symbol,
          qty: heldQty,
          max_slippage_bps: MAX_SLIP_BPS,
        });
        cooldown = COOLDOWN;
        entryClose = null;
        heldBatches = 0;
      }
    }
  } else {
    if (cooldown > 0) {
      cooldown -= 1;
    } else if (
      closes.length > ROC_BARS &&
      closes[closes.length - 1] > closes[closes.length - 1 - ROC_BARS] * ROC_MIN
    ) {
      const notional = Math.floor(cash * SIZE_FRAC);
      if (notional > 0) {
        orderN += 1;
        orders.push({
          side: "buy",
          client_id: `b${orderN}`,
          symbol,
          notional_quote_units: String(notional),
          max_slippage_bps: MAX_SLIP_BPS,
        });
        entryClose = closes[closes.length - 1];
        heldBatches = 0;
      }
    }
  }
  return orders;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line: string) => {
  const text = line.trim();
  if (!text) return;
  const msg = JSON.parse(text);
  if (msg.type === "hello") {
    symbol = msg.symbols[0].symbol;
    return;
  }
  if (msg.type === "done") {
    process.exit(0);
  }
  if (msg.type !== "batch") return;
  const orders = onBatch(msg);
  process.stdout.write(
    JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n",
  );
});
