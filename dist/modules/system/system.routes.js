import { Router } from 'express';
import { JobRunModel } from '../../models/index.js';
import { writeAudit } from '../../shared/audit.js';
import { requireAuth } from '../auth/requireAuth.js';
import { requireRole } from '../auth/requireRole.js';
import { lastIntegrityRun, runIntegrityCheck, runView } from './integrity.js';
/**
 * The integrity check (Build 8): what it found the last time, and "Run now". For the Controller, Founder and
 * Admin. The check only reads, so "Run now" needs no password re-entry.
 */
export const systemRouter = Router();
systemRouter.use('/system', requireAuth, requireRole('CONTROLLER', 'FOUNDER', 'ADMIN'));
/** GET /system/integrity  ->  { last, history }: the latest run with its findings, and the 10 runs before it. */
systemRouter.get('/system/integrity', async (_req, res) => {
    const last = await lastIntegrityRun();
    const history = await JobRunModel.find({ job: 'INTEGRITY_CHECK' })
        .sort({ startedAt: -1 })
        .skip(1)
        .limit(10);
    res.json({
        last: last ? runView(last) : null,
        history: history.map((run) => ({
            id: run.id,
            trigger: run.trigger,
            startedAt: run.startedAt,
            status: run.status,
            findingCount: run.findingCount,
        })),
    });
});
/** POST /system/integrity/run  ->  { run }: runs the check now and answers with the result. */
systemRouter.post('/system/integrity/run', async (req, res) => {
    const run = await runIntegrityCheck('MANUAL', req.user.id);
    await writeAudit(req, {
        action: 'system.integrityRun',
        entityType: 'JobRun',
        entityId: run.id,
        after: { status: run.status, findingCount: run.findingCount },
    });
    res.json({ run: runView(run) });
});
//# sourceMappingURL=system.routes.js.map