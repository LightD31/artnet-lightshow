import { codeOf, messageOf } from './errors.ts';

/**
 * Read `.env` from the working directory into the environment, with Node's
 * own parser (process.loadEnvFile) — what the dotenv package used to do. A
 * variable already set in the environment wins, and no file is normal: almost
 * nothing is configured this way any more (see .env.example).
 *
 * A module of its own, imported first, so the variables are in place before
 * any other module is evaluated.
 */
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
