const pino = require('pino');

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

const logger = pino({
    level: isTest ? 'silent' : (process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug')),
    formatters: {
        level(label) { return { level: label }; },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: undefined,
    transport: !isProduction && !isTest ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    } : undefined,
});

const createChild = (name) => logger.child({ module: name });

module.exports = logger;
module.exports.createChild = createChild;
