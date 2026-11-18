// BTC race bot: slow 60-minute momentum, full-size, with a cooldown, a minimum
// hold and a take-profit. Long only, one position, cash earns nothing, so the
// bot stays in cash unless the last hour's return is clearly up, and it gets
// out when the hour turns down or the position has paid.
//
// Why this shape: on the dev window BTC grinds down with one slow recovery.
// Fast signals (EMA crosses, short momentum) whipsaw: every 1-bar round trip
// pays ~36 bps in fee + slippage + price impact, so anything that trades
// often loses. The only trades that survive are rare ones on a strong
// trailing return, held long enough for the move to outrun the round trip.
//
// Rules, all on 1-minute closes of CBBTC:
//   - buy (100% of cash) when the trailing 60-bar return is above +50 bps,
//     after a 60-bar cooldown since the last sell;
//   - sell everything when, after at least 30 bars held, the trailing
//     60-bar return falls below -40 bps, or the close is 1.5% above the
//     fill entry price;
//   - sell on a stop-loss: if the close falls 0.8% below the fill entry
//     price, exit. The stop never triggered on the dev window (the dev
//     grade is unchanged by it), but it caps the loss on any single trade
//     if the race window drops sharply after an entry, instead of waiting
//     for the slow 60-bar return to turn down.
//   - orders cap their slippage at 200 bps from the latest close.
// Deterministic: no clock, no randomness, no network, no files. History
// includes warm-up bars; no orders are placed during warm-up.

import { runBars } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const LOOKBACK = 60; // bars for the trailing return
const ENTRY_BPS = 50; // buy when trailing 60-bar return > +50 bps
const EXIT_BPS = 40; // sell when trailing 60-bar return < -40 bps
const TAKE_PROFIT = 0.015; // sell at +1.5% over the fill entry price
const STOP_LOSS = 0.008; // sell at -0.8% under the fill entry price
const MIN_HOLD = 30; // bars to hold before any exit
const COOLDOWN = 60; // bars to wait after a sell before re-entering
const MAX_SLIPPAGE_BPS = 200; // vs the latest close

const closes: number[] = [];
let entryPrice: number | null = null;
let buySeq = -1;
let cooldownUntil = -1;

await runBars({
  onBatch(state, batch) {
    const scale = state.symbols.get(SYMBOL)?.price_scale ?? 5;
    const div = 10 ** scale;
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) closes.push(Number(bar.c) / div);
    }
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL) continue;
      if (fill.status === "filled" && fill.side === "buy") {
        entryPrice = Number(fill.price) / div;
      } else if (fill.status === "filled" && fill.side === "sell") {
        entryPrice = null;
      }
    }
    if (state.warmingUp) return [];
    if (closes.length <= LOOKBACK) return [];

    const close = closes[closes.length - 1]!;
    const retBps = (close / closes[closes.length - 1 - LOOKBACK]! - 1) * 10000;
    const pos = state.positions.get(SYMBOL);
    const holding = pos !== undefined && pos.qty > 0n;

    if (!holding) {
      if (state.seq < cooldownUntil) return [];
      if (retBps > ENTRY_BPS && state.cash > 0n) {
        buySeq = state.seq;
        return [
          {
            side: "buy",
            symbol: SYMBOL,
            notional_quote_units: state.cash,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          },
        ];
      }
      return [];
    }

    if (state.seq - buySeq < MIN_HOLD) return [];
    const takeProfit =
      entryPrice !== null && close > entryPrice * (1 + TAKE_PROFIT);
    const stopLoss =
      entryPrice !== null && close < entryPrice * (1 - STOP_LOSS);
    if (retBps < -EXIT_BPS || takeProfit || stopLoss) {
      cooldownUntil = state.seq + COOLDOWN;
      return [
        {
          side: "sell",
          symbol: SYMBOL,
          qty: pos!.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
    return [];
  },
});
