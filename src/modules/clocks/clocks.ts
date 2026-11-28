import { runDailyCreditJob } from '../credit/credit.js';
import { runDormancyClocks } from '../dormancy/dormancy.js';
import type { Types } from 'mongoose';
import { numberSetting } from '../../db/settings.js';
import { TradeModel } from '../../models/index.js';
import { HttpError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import { runIntegrityIfDue } from '../system/integrity.js';
import { runSystemAction, type SystemAction } from '../trades/engine.js';

/**
 * The clocks (SRS §6.5, Q-WF-03). A clock acts when a time limit runs out and nobody pressed the button.
 * Two clocks act by themselves:
 *   `silenceDelivery` (Q-LOG-09, Build 6): a trade at b9 whose delivery window has ended, with no complaint, counts as
 *     delivered. A complaint moves the trade to b11, so a b9 trade never has one open.
 *   `archiveViewing` (Build 7): a b1 viewing nobody touched for B1_ARCHIVE_DAYS (7) is archived.
 * Every other clock only shows (the Controller's Today page lists what is overdue): cancelling an unpaid order,
 * chasing a seller or closing a lost shipment stay human actions (SRS §3.8: "cancellation stays a human action").
 *
 * `runClocks()` is safe to run twice at the same time (two servers, or the timer and a person pressing Run now):
 * the engine's version check lets only one of them change a trade, and the other is skipped.
 */

const HOW_OFTEN_MS = 15 * 60 * 1000;
const AT_A_TIME = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Runs one system action on each trade. Returns how many it moved; a trade someone else moved first is skipped. */
async function runOn(trades: { _id: Types.ObjectId; number: string }[], action: SystemAction) {
  let moved = 0;
  for (const trade of trades) {
    try {
      await runSystemAction(trade._id, action);
      moved++;
    } catch (error) {
      // Someone moved the trade first (a complaint, "Delivered", a touch): nothing to do. Anything else is logged.
      if (!(error instanceof HttpError && error.status === 409)) {
        logger.error({ msg: `${action} failed`, trade: trade.number, error });
      }
    }
  }
  return moved;
}

/** Runs the clocks once. Returns how many trades it delivered and how many viewings it archived. */
export async function runClocks(now = new Date()) {
  const silent = await TradeModel.find({ buyerStage: 'B9_DISPATCH', dueAt: { $lte: now } })
    .sort({ dueAt: 1 })
    .limit(AT_A_TIME);
  const days = await numberSetting('B1_ARCHIVE_DAYS', 7);
  const idle = await TradeModel.find({
    buyerStage: 'B1_VIEWING',
    lastActionAt: { $lte: new Date(now.getTime() - days * DAY_MS) },
  })
    .sort({ lastActionAt: 1 })
    .limit(AT_A_TIME);
  return {
    delivered: await runOn(silent, 'silenceDelivery'),
    archived: await runOn(idle, 'archiveViewing'),
  };
}

/** The daily credit job (reference FAST-ORDER): once per Indian day, on the first tick of the day. */
let creditJobDay = '';
async function runCreditJobIfDue(now = new Date()) {
  const day = new Date(now.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (day === creditJobDay) return;
  creditJobDay = day;
  await runDailyCreditJob(now);
}

/** The dormancy clock (reference LOCK-34 §7, modules/dormancy): once per Indian day, on the first tick of the day. */
let dormancyDay = '';
async function runDormancyIfDue(now = new Date()) {
  const day = new Date(now.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (day === dormancyDay) return;
  dormancyDay = day;
  await runDormancyClocks(now);
}

/**
 * Starts the timer (every 15 minutes). Called once by server.ts; tests call `runClocks()` themselves.
 * The same timer also starts the nightly integrity check: from 2 am Indian time, once a day (Build 8).
 */
export function startClocks() {
  const timer = setInterval(() => {
    runClocks().catch((error: unknown) => logger.error({ msg: 'The clocks failed', error }));
    runIntegrityIfDue().catch((error: unknown) =>
      logger.error({ msg: 'The nightly integrity check failed', error }),
    );
    runCreditJobIfDue().catch((error: unknown) =>
      logger.error({ msg: 'The daily credit job failed', error }),
    );
    runDormancyIfDue().catch((error: unknown) =>
      logger.error({ msg: 'The dormancy clock failed', error }),
    );
  }, HOW_OFTEN_MS);
  timer.unref(); // never keeps the server alive on its own
}
