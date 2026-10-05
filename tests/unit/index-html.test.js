// The page shell (public/index.html).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');

test('the manifest is fetched with cookies, so an SSO proxy in front lets it through', () => {
  // Browsers fetch a manifest without credentials unless told otherwise; behind a
  // cookie-based login the request is redirected to the login page and fails CORS.
  const link = html.match(/<link[^>]*rel="manifest"[^>]*>/);
  assert.ok(link, 'index.html links a manifest');
  assert.match(link[0], /crossorigin="use-credentials"/);
});
