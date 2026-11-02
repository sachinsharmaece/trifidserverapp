import { Router, type Request, type Response } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { AppError } from '../../shared/errors.js';
import * as noticeService from './notice.service.js';

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
  ok(res, req, await noticeService.listMyNotices(employeeOf(req)));
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
