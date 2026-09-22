'use strict';

const { execFile } = require('child_process');

/**
 * What the installed yt-dlp needs to be told.
 *
 * Since 2025.11.12, yt-dlp needs an external JavaScript runtime to solve
 * YouTube's challenges; without one, YouTube downloads degrade and then fail.
 * Only Deno is enabled by default, and most operators do not have Deno — but
 * every one of them has Node, because it is what runs this server. So yt-dlp
 * is pointed at this very executable.
 *
 * Older builds do not know the option and would refuse to run at all with it,
 * so it is only passed to a version that understands it. The version is asked
 * once and remembered; a failed probe is not remembered, so installing yt-dlp
 * while the server runs is picked up on the next download.
 */

// The first release that requires, and accepts, --js-runtimes.
const JS_RUNTIME_SINCE = '2025.11.12';

let versionPromise = null;

function probeVersion() {
  return new Promise((resolve) => {
    execFile('yt-dlp', ['--version'], { timeout: 15000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout || '').trim().split(/\s+/)[0] || null);
    });
  });
}

/** The installed yt-dlp's version string, e.g. "2025.11.12", or null. */
function version() {
  if (!versionPromise) {
    versionPromise = probeVersion().then((v) => {
      if (!v) versionPromise = null;
      return v;
    });
  }
  return versionPromise;
}

/** yt-dlp versions are dates; compare them as YYYYMMDD numbers. */
function dateOf(v) {
  const m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})/.exec(String(v || ''));
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : 0;
}

/** Does this version need, and understand, --js-runtimes? */
function needsJsRuntime(v) {
  return dateOf(v) >= dateOf(JS_RUNTIME_SINCE);
}

/** The arguments that hand yt-dlp a JavaScript runtime, for this version. */
function runtimeArgs(v, execPath = process.execPath) {
  return needsJsRuntime(v) ? ['--js-runtimes', `node:${execPath}`] : [];
}

function _reset() { versionPromise = null; }

module.exports = { version, needsJsRuntime, runtimeArgs, dateOf, JS_RUNTIME_SINCE, _reset };
