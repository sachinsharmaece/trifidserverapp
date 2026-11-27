import { TradeModel } from '../../models/index.js';
import { HttpError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import { runSystemAction } from '../trades/engine.js';

/**
 * The clocks (SRS §6.5, Q-WF-03). A clock acts when a time limit runs out and nobody pressed the button.
 * Built so far: `silenceDelivery` (Q-LOG-09): a trade at b9 whose delivery window has ended, with no complaint,
 * counts as delivered. A complaint moves the trade to b11, so a b9 trade never has one open.
 *
 * `runClocks()` is safe to run twice at the same time (two servers, or the timer and a person pressing Run now):
 * the engine's version check lets only one of them change a trade, and the other is skipped.
 * More clocks (an overdue seller, a b1 that is days old, a lost shipment) come with the Controller's Today queue.
 */

const HOW_OFTEN_MS = 15 * 60 * 1000;
const AT_A_TIME = 200;

/** Marks every b9 trade past its delivery window as delivered. Returns how many it delivered. */
export async function runClocks(now = new Date()) {
  const due = await TradeModel.find({ buyerStage: 'B9_DISPATCH', dueAt: { $lte: now } })
    .sort({ dueAt: 1 })
    .limit(AT_A_TIME);
  let delivered = 0;
  for (const trade of due) {
    try {
      await runSystemAction(trade._id, 'silenceDelivery');
      delivered++;
    } catch (error) {
      // Someone moved the trade first (a complaint, or "Delivered"): nothing to do. Anything else is logged.
      if (!(error instanceof HttpError && error.status === 409)) {
        logger.error({ msg: 'silenceDelivery failed', trade: trade.number, error });
      }
    }
  }
  return { delivered };
}

/** Starts the timer (every 15 minutes). Called once by server.ts; tests call `runClocks()` themselves. */
export function startClocks() {
  const timer = setInterval(() => {
    runClocks().catch((error: unknown) => logger.error({ msg: 'The clocks failed', error }));
  }, HOW_OFTEN_MS);
  timer.unref(); // never keeps the server alive on its own
}
