import { z } from 'zod';
import { RELEASE_REASONS } from '../../models/Holding.js';
const objectId = (what) => z.string().regex(/^[a-f0-9]{24}$/i, `Pick ${what} from the list.`);
export const poolQuerySchema = z.object({
    section: z.enum(['ordered', 'new']).default('new'),
    q: z.string().trim().optional(),
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const reasonSchema = z
    .object({
    reason: z.enum(RELEASE_REASONS, {
        message: 'Pick a reason from the list.',
    }),
})
    .strict();
export const assignSchema = z.object({ callerId: objectId('a caller') }).strict();
export const receivingLeadsSchema = z
    .object({ on: z.boolean({ message: 'Say whether he should receive new leads.' }) })
    .strict();
