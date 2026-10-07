import { codeOf, messageOf } from './errors.ts';

// Load before other modules so startup decisions see the working directory’s environment file.
export function loadEnv(file = '.env'): boolean {
  try {
    process.loadEnvFile(file);
    return true;
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') console.warn(`[env] cannot read ${file}: ${messageOf(err)}`);
    return false;
  }
}

loadEnv();
