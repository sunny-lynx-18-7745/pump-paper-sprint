// Pump.fun paper-trading strategy for make.fun pumpfun-replay/v2.
// Design (my own): catch new launches showing real early buy flow, buy a
// capped slice, exit fast on a take-profit / stop-loss / trailing stop / max
// hold. The edge is the skew: most fresh coins spike briefly after launch,
// so entries must be early, small, and cut quickly; winners are trailed.
//
// Deterministic: no clock, no environment, no Math.random. All state comes
// from the harness batches.
import type { BotState, OrderInput } from './vendor/makefun-bot.ts';

export const LAMPORTS_PER_SOL = 1_000_000_000n;

export interface StrategyParams {
  /** Take profit vs entry price (fraction, e.g. 0.30 = +30%). */
  tp: number;
  /** Stop loss vs entry price (fraction, e.g. 0.12 = -12%). */
  sl: number;
  /** Arm the trailing stop once the peak gain reaches this fraction. */
  arm: number;
  /** Sell when price falls this fraction below its peak (after arming). */
  trail: number;
  /** Max hold in slots after entry. */
  maxHold: number;
  /** Entry only when mint age (slots) is within [minAge, maxAge]. */
  minAge: number;
  maxAge: number;
  /** Entry only when real SOL reserve is at least this (lamports). */
  minReserve: bigint;
  /** Entry only when price rose at least this fraction over ~50 slots. */
  minMom: number;
  /** Entry only when buy volume in the last 100 slots is at least this. */
  minVol: bigint;
  /** Skip entry when price already rose more than this vs launch price. */
  maxEntryGain: number;
  /** Target buy size per coin (lamports), before caps. */
  size: bigint;
  /** Never buy a mint twice (one round trip per mint). */
  noReentry: boolean;
}

export const DEFAULT_PARAMS: StrategyParams = {
  tp: 0.15,
  sl: 0.05,
  arm: 0.2,
  trail: 0.15,
  maxHold: 400,
  minAge: 1,
  maxAge: 300,
  minReserve: 1n * LAMPORTS_PER_SOL,
  minMom: 0,
  minVol: 0n,
  maxEntryGain: 0.3,
  size: LAMPORTS_PER_SOL / 50n,
  noReentry: true,
};

interface MintTrack {
  createdSlot: number;
  price0: number;
  /** Recent (slot, price) samples, oldest first, capped. */
  hist: Array<[number, number]>;
  /** Recent buy trades (slot, lamports), capped. */
  buys: Array<[number, bigint]>;
  /** Entry bookkeeping for a held position. */
  entrySlot: number;
  entryPrice: number;
  peakPrice: number;
}

const MAX_OPEN_POSITIONS = 5;
const MIN_ROUND_TRIP = 10_000_000n; // 0.01 SOL
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 1000;

function curvePrice(c: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): number {
  if (c.virtual_token_reserves === 0n) return 0;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

export function createStrategy(params: StrategyParams = DEFAULT_PARAMS) {
  const track = new Map<string, MintTrack>();
  const pendingBuy = new Set<string>();
  const pendingSell = new Set<string>();
  const traded = new Set<string>();

  function getTrack(mint: string, createdSlot: number | null, price0: number): MintTrack {
    let t = track.get(mint);
    if (!t) {
      t = {
        createdSlot: createdSlot ?? 0,
        price0,
        hist: [],
        buys: [],
        entrySlot: 0,
        entryPrice: 0,
        peakPrice: 0,
      };
      track.set(mint, t);
    }
    return t;
  }

  function onBatch(state: BotState, batch: any): OrderInput[] {
    const slot: number = batch.slot;
    const orders: OrderInput[] = [];

    // Refresh pending sets from the fills that just resolved.
    for (const f of batch.fills ?? []) {
      if (f.status !== 'filled' && f.status !== 'rejected' && f.status !== 'failed') continue;
      if (f.side === 'buy') pendingBuy.delete(f.mint);
      else pendingSell.delete(f.mint);
      // Record entry price from a buy fill on a fresh position.
      if (f.side === 'buy' && f.status === 'filled') {
        traded.add(f.mint);
        const t = track.get(f.mint);
        const tokens = BigInt(f.token_amount);
        const quote = BigInt(f.quote_lamports);
        if (t && tokens > 0n) {
          if (t.entryPrice === 0 || !state.positions.has(f.mint)) {
            // New position (or first fill): set entry from this fill.
          }
          if (!state.positions.has(f.mint) || t.entryPrice === 0) {
            t.entryPrice = Number(quote) / Number(tokens);
            t.entrySlot = slot;
            t.peakPrice = t.entryPrice;
          }
        }
      }
      if (f.side === 'sell' && f.status === 'filled' && !state.positions.has(f.mint)) {
        const t = track.get(f.mint);
        if (t) {
          t.entryPrice = 0;
          t.peakPrice = 0;
          t.entrySlot = 0;
        }
      }
    }

    // Update trackers from this batch's events.
    for (const e of batch.events ?? []) {
      if (e.event === 'CreateEvent') {
        const c = state.curves.get(e.mint);
        const p0 = c ? curvePrice(c) : 0;
        getTrack(e.mint, e.slot, p0);
      } else if (e.event === 'TradeEvent') {
        const c = state.curves.get(e.mint);
        if (!c) continue;
        const t = getTrack(e.mint, c.created_slot, curvePrice(c));
        const px = curvePrice(c);
        t.hist.push([slot, px]);
        if (t.hist.length > 400) t.hist.splice(0, t.hist.length - 400);
        if (e.is_buy) {
          t.buys.push([slot, BigInt(e.sol_amount)]);
          if (t.buys.length > 400) t.buys.splice(0, t.buys.length - 400);
        }
      }
    }

    // Also refresh the price sample for every held curve each batch, so the
    // trailing stop sees moves even on slots with no trade on that mint.
    for (const [mint, holding] of state.positions) {
      const c = state.curves.get(mint);
      if (!c) continue;
      const t = getTrack(mint, c.created_slot, curvePrice(c));
      const px = curvePrice(c);
      const last = t.hist[t.hist.length - 1];
      if (!last || last[0] !== slot) {
        t.hist.push([slot, px]);
        if (t.hist.length > 400) t.hist.splice(0, t.hist.length - 400);
      }
      if (t.entryPrice === 0 && holding.token_amount > 0n) {
        // Fallback entry reference: average cost per token.
        t.entryPrice = Number(holding.cost_lamports) / Number(holding.token_amount);
        t.entrySlot = slot;
        t.peakPrice = t.entryPrice;
      }
      if (px > t.peakPrice) t.peakPrice = px;
    }

    // ---- exits ----
    for (const [mint, holding] of state.positions) {
      const c = state.curves.get(mint);
      if (!c || c.complete) continue;
      if (pendingSell.has(mint)) continue;
      const t = track.get(mint);
      if (!t || t.entryPrice === 0) continue;
      const px = curvePrice(c);
      const ret = px / t.entryPrice - 1;
      const peakRet = t.peakPrice / t.entryPrice - 1;
      let sell = false;
      if (ret >= params.tp) sell = true;
      else if (ret <= -params.sl) sell = true;
      else if (peakRet >= params.arm && px <= t.peakPrice * (1 - params.trail)) sell = true;
      else if (slot - t.entrySlot >= params.maxHold) sell = true;
      if (sell) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
        pendingSell.add(mint);
      }
    }

    // ---- entries ----
    const committed = state.committedPositionCount();
    const selling = orders.filter((o) => o.side === 'sell').length;
    const freeSlots = MAX_OPEN_POSITIONS - committed + selling;
    if (freeSlots > 0) {
      const cands: Array<{ mom: number; mint: string }> = [];
      for (const [mint, c] of state.curves) {
        if (c.complete) continue;
        if (state.positions.has(mint)) continue;
        if (params.noReentry && traded.has(mint)) continue;
        if (pendingBuy.has(mint)) continue;
        if (c.created_slot === null) continue;
        const age = slot - c.created_slot;
        if (age < params.minAge || age > params.maxAge) continue;
        if (c.real_quote_reserves < params.minReserve) continue;
        const t = track.get(mint);
        if (!t || t.hist.length < 5) continue;
        const px = curvePrice(c);
        if (t.price0 > 0 && px / t.price0 - 1 > params.maxEntryGain) continue;
        // Momentum: price vs the most recent sample at least 50 slots old.
        let old: number | null = null;
        for (let i = t.hist.length - 1; i >= 0; i--) {
          if (slot - t.hist[i][0] >= 50) {
            old = t.hist[i][1];
            break;
          }
        }
        if (old === null || old <= 0) continue;
        const mom = px / old - 1;
        if (mom < params.minMom) continue;
        // Buy volume in the last 100 slots.
        let vol = 0n;
        for (let i = t.buys.length - 1; i >= 0; i--) {
          if (slot - t.buys[i][0] > 100) break;
          vol += t.buys[i][1];
        }
        if (vol < params.minVol) continue;
        cands.push({ mom, mint });
      }
      cands.sort((a, b) => b.mom - a.mom);
      let bought = 0;
      for (const cand of cands) {
        if (bought >= freeSlots) break;
        const c = state.curves.get(cand.mint);
        if (!c) continue;
        const cap = state.maxBuyLamports(cand.mint);
        const freeCash = state.freeCashLamports();
        const remaining = freeSlots - bought;
        let size = params.size;
        const perSlot = freeCash / BigInt(Math.max(1, remaining));
        if (size > perSlot) size = perSlot;
        if (size > cap) size = cap;
        if (size < MIN_ROUND_TRIP) continue;
        orders.push({
          side: 'buy',
          mint: cand.mint,
          quote_lamports: size,
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        });
        pendingBuy.add(cand.mint);
        bought++;
      }
    }

    // Prune stale trackers: mints long past the entry window with no position.
    if (track.size > 4000) {
      for (const [mint, t] of track) {
        if (slot - t.createdSlot > params.maxAge + params.maxHold && !state.positions.has(mint)) {
          track.delete(mint);
        }
      }
    }
    return orders;
  }

  return { onBatch };
}
