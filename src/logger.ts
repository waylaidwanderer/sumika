import pino from 'pino';

const isDevelopment = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

const transport = isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
        },
    }
    : undefined;

export default pino({
    level: isDevelopment ? 'debug' : 'info',
    transport,
});
