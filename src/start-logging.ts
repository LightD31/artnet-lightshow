import { startLogging, logger } from './server/log.ts';
import { logDir } from './server/config-dir.ts';

/**
 * The server's log, started before anything else is loaded, so what a module
 * says while it loads — a settings file moved aside, a profile that would not
 * parse — is in the file and the log view too (src/server/log.ts).
 */
const { file } = startLogging({ dir: logDir() });

logger('server').info({ node: process.version, pid: process.pid, log: file }, 'starting');
