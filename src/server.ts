import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectToDatabase } from './db/connect.js';

async function startServer(): Promise<void> {
  await connectToDatabase(env.mongodbUri);
  createApp().listen(env.port, () => {
    console.log(`TriFid server listening on port ${env.port}`);
  });
}

startServer().catch((error: unknown) => {
  console.error('Unable to start server', error);
  process.exitCode = 1;
});
