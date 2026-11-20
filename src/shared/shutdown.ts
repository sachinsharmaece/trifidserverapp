import type { Server } from 'node:http';
import { env } from '../config/env.js';
import { disconnectFromDatabase } from '../db/connect.js';
import { logger } from './logger.js';

let shuttingDown = false;

/** Lets the readiness probe tell the load balancer to stop sending traffic. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function registerShutdownHandlers(server: Server): void {
  async function shutdown(reason: string, exitCode: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ msg: `${reason} - shutting down gracefully` });

    // Hard stop if something hangs (stuck connection, slow DB close, ...).
    setTimeout(() => {
      logger.error({ msg: `Shutdown exceeded ${env.shutdownTimeoutMs}ms - forcing exit` });
      process.exit(1);
    }, env.shutdownTimeoutMs).unref();

    try {
      // Stop accepting new connections; resolves once in-flight requests finish.
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
      await disconnectFromDatabase();
      logger.info({ msg: 'Shutdown complete' });
      process.exit(exitCode);
    } catch (error) {
      logger.error({ msg: 'Error during shutdown', error });
      process.exit(1);
    }
  }

  server.on('error', (error: NodeJS.ErrnoException) => {
    logger.error({
      msg: error.code === 'EADDRINUSE' ? `Port ${env.port} is already in use` : 'Server error',
      error,
    });
    void shutdown('Server error', 1);
  });

  process.on('SIGINT', () => void shutdown('SIGINT received', 0));
  process.on('SIGTERM', () => void shutdown('SIGTERM received', 0));
  process.on('unhandledRejection', (reason) => {
    logger.error({ msg: 'Unhandled promise rejection', error: reason });
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (error) => {
    logger.error({ msg: 'Uncaught exception', error });
    void shutdown('uncaughtException', 1);
  });
}
