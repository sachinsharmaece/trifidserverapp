import type { RequestHandler } from 'express';

export const notFound: RequestHandler = (_request, response) => {
  response.status(404).json({ error: 'Route not found' });
};
