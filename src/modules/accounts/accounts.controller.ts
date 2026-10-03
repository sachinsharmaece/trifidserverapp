import type { Request, Response } from 'express';
import * as accountsService from './accounts.service.js';

// 🏢 chain:read_full — see accounts.routes.ts.
export async function getAccountsSnapshot(req: Request, res: Response): Promise<void> {
  const data = await accountsService.buildAccountsSnapshot();
  res.status(200).json({ data, meta: { correlationId: req.correlationId } });
}
