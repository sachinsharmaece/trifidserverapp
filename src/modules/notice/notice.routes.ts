import { Router, type Request, type Response } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { AppError } from '../../shared/errors.js';
import * as noticeService from './notice.service.js';
import { isMarketplacePaused, isPileRequoteEnabled } from '../marketplace/marketplace.guard.js';

export const noticeRouter = Router();

// Phase 6 — the bell. Every staff member reads only his own notices, so no
// permission beyond being signed in as staff.
function employeeOf(req: Request): string {
  const employeeId = req.auth?.employeeId;
  if (!employeeId) {
    throw new AppError({ code: 'PERMISSION_DENIED', messageEn: 'Staff notices are for staff.' });
  }
  return employeeId;
}

function ok(res: Response, req: Request, data: unknown): void {
  res.status(200).json({ data, meta: { correlationId: req.correlationId } });
}

noticeRouter.get('/staff/notices', authenticate, async (req, res) => {
  const notices = await noticeService.listMyNotices(employeeOf(req));
  // RECTIFY-01 Phase 0 — the bell is the one call every desk makes on a timer, so the two switches the
  // desks must react to ride on it (optional fields; nothing that read the response before reads them):
  // the "trading is paused" banner, and whether Requote may still be offered.
  ok(res, req, {
    ...notices,
    marketplacePaused: await isMarketplacePaused(),
    pileRequoteEnabled: await isPileRequoteEnabled(),
  });
});

noticeRouter.post('/staff/notices/read-all', authenticate, async (req, res) => {
  await noticeService.markAllRead(employeeOf(req));
  ok(res, req, { read: true });
});

noticeRouter.post('/staff/notices/:noticeId/read', authenticate, async (req, res) => {
  const noticeId = req.params.noticeId as string;
  if (!/^[a-f0-9]{24}$/i.test(noticeId)) {
    throw new AppError({ code: 'NOT_FOUND', messageEn: 'Notice not found.' });
  }
  await noticeService.markRead(employeeOf(req), noticeId);
  ok(res, req, { read: true });
});
