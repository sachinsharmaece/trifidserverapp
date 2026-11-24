import mongoose from 'mongoose';
import { logger } from '../shared/logger.js';
export async function connectToDatabase(uri) {
    await mongoose.connect(uri, {
        // Fail fast at boot instead of hanging for the 30s default.
        serverSelectionTimeoutMS: 5_000,
    });
    logger.info({ msg: 'MongoDB connected' });
    // Runtime events only - a failed *initial* connect rejects the call above.
    // The driver reconnects on its own; we just surface what happened.
    mongoose.connection.on('error', (err) => logger.error({ msg: `MongoDB error: ${err.message}` }));
    mongoose.connection.on('disconnected', () => logger.warn({ msg: 'MongoDB disconnected' }));
    mongoose.connection.on('reconnected', () => logger.info({ msg: 'MongoDB reconnected' }));
}
export async function disconnectFromDatabase() {
    await mongoose.disconnect();
}
export function isDatabaseConnected() {
    return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
}
//# sourceMappingURL=connect.js.map