type LogFields = { msg: string; [key: string]: unknown };
type Level = 'info' | 'warn' | 'error';

// Same call shape as pino (`logger.info({ msg, ...fields })`), so swapping in
// pino later means changing this file only.
function write(level: Level, fields: LogFields): void {
  const line = JSON.stringify(
    { level, time: new Date().toISOString(), ...fields },
    (_key, value: unknown) =>
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value,
  );
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(line);
}

export const logger = {
  info: (fields: LogFields) => write('info', fields),
  warn: (fields: LogFields) => write('warn', fields),
  error: (fields: LogFields) => write('error', fields),
};
