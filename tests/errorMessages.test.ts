import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorHandler } from '../src/middleware/error-handler.js';

// A bare app around the real error handler: a schema with no messages of its
// own, so every issue would otherwise carry Zod's built-in wording.
const schema = z
  .object({
    firm: z.string().min(1),
    code: z.string().min(4),
    qty: z.number().int().min(1),
    kind: z.enum(['buyer', 'seller']),
    tags: z.array(z.string()).min(2),
    named: z.string().min(1, 'Enter the firm name.'),
  })
  .strict();

const app = express();
app.use(express.json());
app.post('/probe', (req, res) => {
  res.json(schema.parse(req.body));
});
app.use(errorHandler);

describe('validation errors reach a screen in plain language (Phase 0)', () => {
  it('replaces Zod defaults and keeps a schema-specific message', async () => {
    const response = await request(app)
      .post('/probe')
      .send({ code: 'ab', qty: 0, kind: 'other', tags: ['x'], named: '', extra: 1 });

    expect(response.status).toBe(400);
    const byField = Object.fromEntries(
      (response.body.error.fieldErrors as { field: string; message: string }[]).map((fe) => [
        fe.field,
        fe.message,
      ]),
    );
    expect(byField.firm).toBe('This field is required.');
    expect(byField.code).toBe('Enter at least 4 characters.');
    expect(byField.qty).toBe('Must be at least 1.');
    expect(byField.kind).toBe('Pick one of the listed options.');
    expect(byField.tags).toBe('Add at least 2.');
    expect(byField.named).toBe('Enter the firm name.');
    expect(byField['']).toBe('This form sent a field the server does not accept.');
    for (const message of Object.values(byField)) {
      expect(message).not.toMatch(/expected|Too small|Invalid input/);
    }
  });
});
