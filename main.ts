// Pump.fun Paper Sprint entry: momentum launch trader.
//
// Buys fresh pump.fun launches that show real early buy flow, then exits on
// take-profit / stop-loss / trailing stop / max hold. See strategy.ts for
// the full design and parameters.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
