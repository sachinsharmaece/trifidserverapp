// Adds our own fields to Express's Request type.
declare global {
  namespace Express {
    interface Request {
      /** Unique id of this request. Sent back as the `X-Request-Id` header and in every error body. */
      requestId: string;
      /** The signed-in user. Set by `requireAuth`, so it exists only on routes that use it. */
      user?: { id: string; email: string; name: string; role: import('../shared/enums.js').Role };
    }
  }
}

export {};
