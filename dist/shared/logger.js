// Same call shape as pino (`logger.info({ msg, ...fields })`), so swapping in
// pino later means changing this file only.
function write(level, fields) {
    const line = JSON.stringify({ level, time: new Date().toISOString(), ...fields }, (_key, value) => value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value);
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    sink(line);
}
export const logger = {
    info: (fields) => write('info', fields),
    warn: (fields) => write('warn', fields),
    error: (fields) => write('error', fields),
};
//# sourceMappingURL=logger.js.map