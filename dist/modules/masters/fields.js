import { z } from 'zod';
/** A required name. Extra spaces are tidied: "  Bayer   Crop " is saved as "Bayer Crop". */
export const nameField = (what, max = 150) => z
    .string()
    .trim()
    .min(1, `Enter ${what}.`)
    .max(max)
    .transform((text) => text.replace(/\s+/g, ' '));
/** Optional extra detail. An empty text means "no description". */
export const descriptionField = z.string().trim().max(300);
//# sourceMappingURL=fields.js.map