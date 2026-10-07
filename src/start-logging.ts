import { startLogging, logger } from './server/log.ts';
import { logDir } from './server/config-dir.ts';

const { file } = startLogging({ dir: logDir() });

logger('server').info({ node: process.version, pid: process.pid, log: file }, 'starting');
