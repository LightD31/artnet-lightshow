# Code Audit — artnet-lightshow

**Date:** 2026-09-07 · **Commit audited:** `36c234f` · **Scope:** whole repository

Each finding names a file and line so it can be triaged independently.

> **Status.** The audit was written first as a review-only document. **PR 1 (Security)**,
> **PR 2 (Stability)** and **PR 3 (Performance)** have since been implemented, so C1, C2,
> H1, H2, H3, H4, H5, M1, M2, M4, M5, M6, M7, M8 and L6 are marked ✅ Fixed below and
> their line references point at the *pre-fix* code. Everything else is still open — see
> the [Suggested order of work](#8-suggested-order-of-work).
>
> **One correction.** M1 originally called the 10 Hz broadcast "the dominant runtime
> cost". Measurement did not support that: building and serializing the payload costs
> ~38 µs, so ~0.4 ms/s per client — negligible CPU. The real costs were **bandwidth**
> (70.5 KB/s per client measured, 63% of it static data re-sent unchanged) and the
> **client re-render** it drove. The claim is corrected in the finding below.

---

## 1. Scope and method

Read in full: `server.js`, all of `src/server/`, `src/auto-show.js` (analysis and
download paths), `src/analyzer-worker.js`, `src/analysis-cache.js`, `src/spotify.js`,
`src/deezer.js`, `src/gdtf.js`, `src/midi.js`, `src/nowplaying-source.js`,
`src/smtc-source.js`, `public/settings.js`, `public-src/`, `browser-extension/`,
`companion-module/src/`, `scripts/`, `README.md`, `requirements.txt`, `package.json`.

Read partially: `src/prolink.js` (interface and lifecycle, not the full beat-grid
maths), `src/essentia-analyze.py` (imports, worker protocol and the PANNs bootstrap;
**the DSP and musical logic were not verified for correctness**), `public/style.css`.

Tooling: `npm audit --omit=dev`, `git ls-files`, targeted greps. No dynamic testing —
the server was not run and no fixtures were driven, so every finding is from reading
the source.

**Not covered:** whether the generated shows are musically good, GDTF spec conformance
beyond the parser's own assumptions, and the correctness of the Companion presets
against real Stream Deck hardware.

---

## 2. Findings at a glance

| ID | Severity | Area | Summary | Status |
|----|----------|------|---------|--------|
| [C1](#c1--stored-xss-via-fixture-profile-and-label-fields) | Critical | Client | Stored XSS via GDTF-supplied profile names and fixture labels | ✅ Fixed |
| [C2](#c2--no-authentication-server-listens-on-all-interfaces) | Critical | Server | No authentication; binds to `0.0.0.0` | ✅ Fixed |
| [H1](#h1--unhandled-dgram-error-crashes-the-process-mid-show) | High | Art-Net | Unhandled UDP socket error kills the server mid-show | ✅ Fixed |
| [H2](#h2--wildcard-cors-on-apideezer-lets-any-website-drive-the-show) | High | Server | Wildcard CORS lets any website drive the show | ✅ Fixed |
| [H3](#h3--spotify-oauth-has-no-state-parameter) | High | Auth | Spotify OAuth has no `state` parameter (login CSRF) | ✅ Fixed |
| [H4](#h4--17-known-vulnerable-dependencies-11-rated-high) | High | Deps | 17 vulnerable dependencies, 11 rated high | ✅ Fixed |
| [H5](#h5--unverified-310-mb-pytorch-checkpoint-download) | High | Supply chain | 310 MB PyTorch checkpoint downloaded without checksum | ✅ Fixed |
| [M1](#m1--10-hz-full-state-broadcast-re-sends-mostly-static-data) | Medium | Performance | 10 Hz broadcast re-sends mostly-static data | ✅ Fixed |
| [M2](#m2--client-re-renders-the-whole-tree-10-times-per-second) | Medium | Performance | Client re-renders whole tree 10×/second | ✅ Fixed |
| [M3](#m3--gdtf-channelcount-is-the-channel-count-not-the-address-footprint) | Medium | Correctness | GDTF `channelCount` wrong → stale DMX channels latch | Open |
| [M4](#m4--analyzer-worker-has-no-timeout-one-hang-stalls-everything) | Medium | Correctness | Analyzer worker has no timeout; delivers mismatched responses | ✅ Fixed |
| [M5](#m5--no-request-timeouts-or-rate-limit-handling-on-spotify-calls) | Medium | Robustness | No timeouts, status checks or 429 backoff on Spotify | ✅ Fixed |
| [M6](#m6--arbitrary-local-file-read-via-the-analyze-endpoint) | Medium | Server | Arbitrary local-file read via analyze endpoint | ✅ Fixed |
| [M7](#m7--prototype-manipulation-via-registerprofile) | Medium | Server | `__proto__` as a profile id corrupts the profile registry | ✅ Fixed |
| [M8](#m8--zip-bomb--xml-dos-on-gdtf-upload) | Medium | Server | Zip-bomb / XML DoS on GDTF upload | ✅ Fixed |
| [M9](#m9--readme-documents-a-removed-feature-and-the-wrong-midi-map) | Medium | Docs | README documents a removed feature and the wrong MIDI map | Open |
| [M10](#m10--requirementstxt-cannot-install-the-analyzer) | Medium | Setup | `requirements.txt` is missing three required packages | Open |
| [L1](#l1--build-artifacts-and-local-config-are-committed) | Low | Hygiene | Build artifacts and local config committed | Open |
| [L2](#l2--font-loaded-from-a-cdn-in-a-venue-tool) | Low | Reliability | Font loaded from a CDN in an offline-capable tool | Open |
| [L3](#l3--midi-monitor-logging-left-enabled) | Low | Hygiene | "Temporary" MIDI monitor logging still enabled | Open |
| [L4](#l4--art-net-sequence-byte-hardcoded-to-zero) | Low | Art-Net | Sequence byte hardcoded to 0 | Open |
| [L5](#l5--socket-midi-connect-skips-validation) | Low | Consistency | Socket `midi-connect` skips schema validation | Open |
| [L6](#l6--no-timeouts-size-caps-or-redirect-limit-in-the-deezer-downloader) | Low | Robustness | Deezer downloader: no timeout, size cap or redirect limit | ✅ Fixed |
| [L7](#l7--fixture-addresses-may-overlap-or-run-past-channel-512) | Low | Correctness | Fixture addresses may overlap or exceed channel 512 | Open |
| [L8](#l8--dead-code-and-stale-comments) | Nit | Hygiene | Dead code and stale comments | Open |
| [L9](#l9--no-linter-formatter-ci-or-test-runner) | Low | Tooling | No linter, formatter, CI or test runner | Open |
| [L10](#l10--undocumented---openssl-legacy-provider) | Nit | Ops | Undocumented `--openssl-legacy-provider` | Open |
| [L11](#l11--browser-extension-is-manifest-v2-with-a-hardcoded-port) | Low | Extension | Manifest V2 with a hardcoded port | Open |
| [L12](#l12--getclientstate-returns-internal-mutable-objects) | Nit | Design | `getClientState()` leaks internal mutable objects | Open |

---

## 3. Critical

### C1 — Stored XSS via fixture profile and label fields

**✅ Fixed.**

**Where:** `public/settings.js:163`, `:222-231`, `:261-274`

Six attacker-controllable strings are interpolated raw into `innerHTML`:

```js
tag.innerHTML = `<span class="ch-num">${ch.offset + 1}</span><span class="ch-name">${ch.name}</span>`;
// ...
<span class="profile-name">${p.name}</span>
<span class="profile-manufacturer">${p.manufacturer}</span>
<span class="profile-mode">${p.modeName} &mdash; ${p.channelCount}ch</span>
// ...
<td><input type="text" value="${fix.label}" data-field="label" data-id="${fix.id}" /></td>
```

`fix.label` sits inside an HTML attribute with no escaping, so a label containing
`" onfocus=…` breaks out of the attribute directly.

**How the values get there.** Three independent paths, none of which require any
credential:

1. A `.gdtf` upload. `src/gdtf.js:95-96,118,129` lifts `@_Name`, `@_Manufacturer` and the
   channel-function `@_Name` straight out of the archive's `description.xml` with no
   sanitisation, and `public/settings.js:206-217` posts them back as a profile.
2. `POST /api/profiles`. `profileSchema` (`src/server/validation.js:68-80`) bounds
   *length* but not content, and uses `.passthrough()` so unknown fields survive too.
3. The `fixture` socket event (`src/server/sockets.js:31-44`) sets `label` with only a
   64-char cap.

**Why it matters here.** Profiles persist in the registry and are broadcast to every
connected client, so this is stored, not reflected — the payload fires for the operator
every time they open the settings page. Given C2 it is reachable from any device on the
venue network, and a downloaded GDTF from an untrusted source is enough on its own.
Script running on that page has full access to the unauthenticated control API.

**Suggested fix.** Build these nodes with `createElement` + `textContent`. The same file
already does it correctly at `:141-147` for the mode `<select>`, so the pattern is
in-repo. Where a template is genuinely more readable, escape at interpolation with a
small `esc()` helper. The Preact client (`public-src/`) is clean — no
`dangerouslySetInnerHTML` anywhere — so this is confined to `public/settings.js`.

**Effort:** small (one file, ~40 lines).

---

### C2 — No authentication; server listens on all interfaces

**✅ Fixed.**

**Where:** `server.js:84` — `server.listen(PORT, …)` with no host argument

Every REST route in `src/server/routes.js` and every Socket.IO event in
`src/server/sockets.js` is unauthenticated. Node's default with no host binds to all
interfaces, so on a venue network anyone who can reach port 3000 can:

- blackout the show or force `all-on` / strobe energy overrides (`/api/energy/:id`);
- repoint Art-Net output at an arbitrary host and port (`/api/set` → `artnet`), which
  also chains into [H1](#h1--unhandled-dgram-error-crashes-the-process-mid-show);
- queue analyzer jobs and yt-dlp downloads (`/api/auto/analyze`);
- register profiles, which chains into [C1](#c1--stored-xss-via-fixture-profile-and-label-fields).

There is also no CSRF protection. `POST /api/blackout/toggle`, `/api/master/:value`,
`/api/energy/:id` and friends take no body, so they are *simple* cross-origin requests —
any page the operator has open in another tab can fire them at `localhost:3000` with no
preflight and no cooperation from the server.

**Suggested fix (matching the deployment model in use).** Default `HOST=127.0.0.1`.
Setting `HOST=0.0.0.0` opts into LAN exposure and then requires a shared
`LIGHTSHOW_TOKEN`, enforced by one Express middleware plus an `io.use()` handshake check.
Compare with `crypto.timingSafeEqual`, not `===`. For the CSRF half, require a custom
header (e.g. `X-Lightshow-Token`) on all mutating routes — that alone forces a preflight
and blocks the simple-request path even before the token is checked.

**Both production integrations need a matching change:**

- `companion-module/src/config.js` gains a token field beside host/port, passed as
  `io(url, { auth: { token } })` from `companion-module/src/main.js:53`.
- `browser-extension/background.js:12-18` sends the token as a header. It needs an
  options page to hold it (see [L11](#l11--browser-extension-is-manifest-v2-with-a-hardcoded-port)).

This is proportionate defence against a curious phone on the same Wi-Fi. It is not a
hardened auth system and should not be described as one.

**Effort:** medium — the server side is contained, but it touches both integrations.

---

## 4. High

### H1 — Unhandled `dgram` error crashes the process mid-show

**✅ Fixed.**

**Where:** `src/server/artnet.js:5,25`

```js
const udpSocket = dgram.createSocket('udp4');   // no 'error' listener
// ...
udpSocket.send(packet, 0, packet.length, port, host);   // no callback
```

A `dgram` socket with no `'error'` listener and a `send()` with no callback turns any
`ENETUNREACH`, `EACCES` (broadcast to a network that disallows it) or DNS failure into an
unhandled `'error'` event, which terminates the process.

`state.artnet.host` is user-settable to any non-empty string — `artnetSchema`
(`src/server/validation.js:12-16`) only requires `z.string().min(1)`, and
`src/server/patch.js:50` assigns it straight through. A typo in the ArtNet settings panel
is enough to kill the server, and `renderDmx` fires this every 25 ms
(`src/server/engine.js:183`).

There is a second cost: `send()` with a hostname re-resolves DNS on **every call**, so a
non-IP host means 40 DNS lookups per second.

**Suggested fix.** Attach `udpSocket.on('error', …)` that logs with rate limiting and
keeps running; validate `host` as an IPv4 address or resolvable hostname at the schema
level; resolve once on change and cache the address.

**Effort:** small.

---

### H2 — Wildcard CORS on `/api/deezer` lets any website drive the show

**✅ Fixed.**

**Where:** `src/server/routes.js:302-308`

```js
res.header('Access-Control-Allow-Origin', '*');
res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
res.header('Access-Control-Allow-Headers', 'Content-Type');
```

This makes `POST /api/deezer/state` callable cross-origin by **any** page, with
`Content-Type: application/json` explicitly allowed. The body flows to
`integrations.onDeezerState` (`src/server/integrations.js:478-483`) →
`prefetchDeezerQueue` → `autoShow.prefetch`, so an arbitrary website can inject fake
now-playing state and make the server run yt-dlp downloads for attacker-chosen search
strings.

**The header is also unnecessary.** The comment in `browser-extension/background.js:3-5`
says it outright: the fetch was moved to the background script *specifically* so it is
not subject to page CORS, and the host permission in `manifest.json:4` covers it. The
route comment at `routes.js:300-301` describes the older content-script design.

**Suggested fix.** Remove the middleware. If some path still needs it, scope
`Access-Control-Allow-Origin` to the extension's `moz-extension://<id>` origin rather
than `*`. Verify against the installed extension before removing — it is in production
use.

**Effort:** small, but needs a manual check with the real extension.

---

### H3 — Spotify OAuth has no `state` parameter

**✅ Fixed.**

**Where:** `src/spotify.js:53-63` (authorize URL), `src/server/routes.js:261-274` (callback)

```js
const params = new URLSearchParams({
  response_type: 'code',
  client_id: this.clientId,
  scope: scopes,
  redirect_uri: this.localCallbackUrl,
});   // no `state`
```

The callback accepts any `code` presented to it with no nonce check. Any page can
navigate the operator's browser to
`http://localhost:3000/auth/spotify/callback?code=<attacker's code>` and silently bind
the operator's server to the attacker's Spotify account — classic login CSRF. Downstream
the show then follows the attacker's playback.

**Two related notes on the same flow:**

- Authorization codes round-trip through a third-party proxy
  (`PROXY_BASE = 'https://api.drndvs.fr'`, `src/spotify.js:21`), so that host sees every
  code in the exchange. That is a real trust dependency and should be documented in the
  README even if the design stays.
- `redirect_uri` sent to the proxy login endpoint is `this.localCallbackUrl`
  (`:60`), i.e. caller-influenced, which is the shape of an open redirect through the
  proxy. Worth confirming the proxy validates it.

**Suggested fix.** Generate a random `state`, keep it server-side with a short TTL,
require an exact match in the callback, and reject when absent.

**Effort:** small.

---

### H4 — 17 known-vulnerable dependencies, 11 rated high

**✅ Fixed.**

**Where:** `package.json`, `package-lock.json`. Reproduce with `npm audit --omit=dev`.

| Package | Severity | Reached via | Note |
|---|---|---|---|
| `axios` | High | `d-fi-core` | ~20 advisories: SSRF, prototype pollution, header injection, credential leakage |
| `ws` | High | `socket.io` → `engine.io` | Memory-exhaustion DoS from tiny fragments |
| `socket.io-parser` | High | `socket.io` | Zero-attachment memory exhaustion |
| `form-data` | High | transitive | CRLF injection via unescaped field names |
| `ip-address` | High | `prolink-connect` | **No fix available**; SSRF via octal-octet parsing |
| `express`, `qs`, `body-parser` | Moderate | direct | DoS via `isBuffer` / silently disabled size limits |
| `cookie` | Low | `@sentry/node` | Out-of-bounds characters |

The `ws` and `socket.io-parser` issues matter most in practice: they are reachable by any
client that can open a socket, which today is everyone (see [C2](#c2--no-authentication-server-listens-on-all-interfaces)).

**Suggested fix.** `npm audit fix` first, then a deliberate pass to bring `express` to 5.x
and `socket.io` to current, with a smoke test of the UI, Companion module and extension.
`d-fi-core` and `prolink-connect` are the two dependencies pinning old transitive
versions; both may eventually need replacing or vendoring. `@sentry/node` appears to be
transitive — worth checking whether anything actually needs it.

**Effort:** medium; do it as its own PR so a regression is easy to bisect.

---

### H5 — Unverified 310 MB PyTorch checkpoint download

**✅ Fixed.**

**Where:** `scripts/setup-panns.py:31-40`

```python
LABELS_URL = (
    'http://storage.googleapis.com/us_audioset/youtube_corpus/v1/csv/'   # plain HTTP
    'class_labels_indices.csv'
)
CHECKPOINT_URL = (
    'https://zenodo.org/record/3987831/files/Cnn14_mAP%3D0.431.pth?download=1'
)
LABELS_MIN_SIZE = 10 * 1024
CHECKPOINT_MIN_SIZE = 300 * 1024 * 1024
```

Integrity is checked by **file size only**. The labels CSV is fetched over plain HTTP, so
it is trivially tamperable by anyone on the path. A `.pth` is a Python pickle loaded by
`torch.load`, so a substituted checkpoint is arbitrary code execution on the operator's
machine.

This is not a manual step: `src/essentia-analyze.py:73-100` auto-runs the setup script the
first time an analysis needs the classifier, so it fires unattended on a fresh install.

**Suggested fix.** HTTPS for both URLs, pin a SHA-256 for each artifact, verify after
download and fail closed on mismatch. Consider `weights_only=True` if the loading path
can be brought under this repo's control.

**Effort:** small.

---

## 5. Medium

### M1 — 10 Hz full-state broadcast re-sends mostly-static data

**✅ Fixed.**

> **Correction to the original finding**, which was titled "the dominant runtime cost".
> Measured, the server-side CPU is ~38 µs per build+serialize — about 0.4 ms/s per client
> at 10 Hz, which is negligible. The genuine problems were bandwidth and the client
> re-render this drove; both are quantified below.

**Where:** `src/server/integrations.js:466`

```js
setInterval(() => io.emit('state', getClientState()), 100);
```

Unconditional, regardless of whether anything changed. `getClientState()`
(`src/server/state.js:70-97`) rebuilds, per tick:

- all 24 colour presets, 25 patterns, 9 strobe functions and 5 energy effects — static
  data that never changes after boot;
- every fixture profile including full `channelMap` and `channelList`;
- a fresh `dmxSnapshot` array via `Array.from(dmx.slice(…))`;
- `extras()` (`integrations.js:59-81`), which calls `prolink.getTrack()`,
  `prolink.getLoadedTracks()`, `midi.listPorts()`, `spotify.getStatus()` and
  `autoShow.getClientState()`.

All of it is then JSON-serialised per connected client. This runs on the same machine as
a 40 Hz DMX render loop (`engine.js:183`) and a CPU-saturating Python analyzer — the
three compete for exactly the cycles the show depends on. `broadcast()` also fires on
every patch, on top of the interval.

**Suggested fix.** Split the channel:

- a small hot event at 10 Hz carrying only what actually moves (`dmxSnapshot`, bpm,
  `_step`);
- the full `state` event only when something changes;
- static catalogues (colour presets, patterns, strobe functions, energy effects) sent
  once on connect and never again.

Note `midi.listPorts()` is already cached (`src/midi.js:103-110`), so it is not itself
the problem — the serialisation volume is.

**Effort:** medium; pair with [M2](#m2--client-re-renders-the-whole-tree-10-times-per-second) since they are two halves of one issue.

---

### M2 — Client re-renders the whole tree 10 times per second

**✅ Fixed.**

**Where:** `public-src/main.jsx:61`

```js
function Root() {
  // Touch the signal so the whole tree re-renders on every state push.
  void stateSig.value;
```

Subscribing the root component to the signal means `Header`, `CommandBar`, `Patterns`,
`Colors`, `Fixtures`, `AutoMode`, `AutoTimeline` and `BottomDrawer` all reconcile on every
100 ms push from [M1](#m1--10-hz-full-state-broadcast-re-sends-mostly-static-data). This
defeats the point of `@preact/signals`, whose whole value is fine-grained subscription.

The comment is honest about what it does, so this reads as a deliberate shortcut rather
than an accident — but it is the client-side half of the same cost, and it is most
visible on the low-powered machines these tools often run on.

**Suggested fix.** Read `stateSig.value` in the leaf components that need each slice, and
split the signal so `dmxSnapshot` updates do not wake the control surfaces.

**Effort:** medium.

---

### M3 — GDTF `channelCount` is the channel *count*, not the address footprint

**Where:** `src/gdtf.js:153`

```js
return { modeName, channelCount: channelList.length, channelMap, channelList };
```

`channelMap` stores raw DMX offsets (`:112`), which can be sparse or high, while
`channelCount` is just how many channel entries exist. For any mode where those differ,
three things break:

1. **Stale DMX latches.** `src/server/engine.js:135` clears
   `for (c < chCount)` and then `:158-163` writes `dmx[base + ch.red]` — an offset beyond
   `channelCount` is written but never cleared, so its last value sticks until master
   blackout.
2. **Auto-addressing is wrong.** `routes.js:186-198` computes the next free address as
   `fix.address + profile.channelCount`, so new fixtures get placed on top of the tail of
   the previous one.
3. **Overlap detection is wrong.** The settings page derives its address range from
   `channelCount` (`public/settings.js:256-258`), so it reports "no conflict" for
   fixtures that really do overlap.

**Suggested fix.** `channelCount = max(offset) + 1`, keeping the entry count separately if
the UI wants to show it.

**Effort:** small, but re-test with a real multi-mode GDTF file.

---

### M4 — Analyzer worker has no timeout; one hang stalls everything

**✅ Fixed.**

**Where:** `src/analyzer-worker.js:193-209` and `:179-190`

Two distinct problems in the request/response path.

**No watchdog.** Exactly one request is in flight at a time by design, and nothing bounds
how long it may take. If the Python process wedges — a corrupt WAV, a librosa edge case,
an OOM that does not kill the process — `_pending` never settles, `_tick()` never runs
again, and every queued prefetch waits forever. During a set that means the auto-show
silently stops picking up new tracks with no error surfaced anywhere.

**Mismatched responses are delivered anyway.** At `:183-189`:

```js
if (resp.id !== this._pending.id) {
  console.warn(`[analyzer] response id mismatch: got ${resp.id}, expected ${this._pending.id}`);
}
const p = this._pending;
this._pending = null;
if (resp.error) p.reject(new Error(resp.error));
else p.resolve(resp.result);
```

The mismatch is logged and then the response resolves the pending caller regardless — so
one track's analysis gets handed to a different track's request, and the show runs a
timeline built for the wrong song. Reachable after a respawn, when a stale response can
still arrive.

**Suggested fix.** Add a per-request timeout that rejects the caller and respawns the
worker; `return` on id mismatch instead of falling through. Consider capping consecutive
respawns so a missing Python install fails loudly rather than looping.

**Effort:** small.

---

### M5 — No request timeouts or rate-limit handling on Spotify calls

**✅ Fixed.**

**Where:** `src/spotify.js:208-232`

The hand-rolled `_request` helper has:

- **no timeout** — a hung connection leaks a promise that never settles;
- **no status-code check** — a 401 or 429 body is `JSON.parse`d and returned as if it were
  data, so `getCurrentlyPlaying()` reports nonsense rather than an error;
- **no `Retry-After` handling** — polling runs at 1 Hz (`integrations.js:133`) plus a
  queue peek every 15 s (`integrations.js:43`), which is squarely in 429 territory for
  `/v1/me/player/currently-playing`;
- **unbounded response accumulation** into a string.

Errors are then swallowed at `:150` (`catch (_) { /* ignore transient errors */ }`), so a
sustained rate-limit looks like "Spotify just stopped working".

**Suggested fix.** Node 20 has global `fetch` — replacing `_request` with
`fetch` + `AbortSignal.timeout()` removes the whole helper and gets status handling for
free. Check `res.ok`, honour `Retry-After` with backoff, and surface repeated failures to
the UI rather than swallowing them. Separately, `.unref()` the refresh timer at `:188-190`
so it does not hold the process open at shutdown.

**Effort:** small.

---

### M6 — Arbitrary local-file read via the analyze endpoint

**✅ Fixed.**

**Where:** `src/server/routes.js:331-338`

```js
const isLocalFile = /^[a-zA-Z]:[\\/]|^\//.test(source);
// ...
if (isLocalFile || isDirectAudio) { await autoShow.analyze(source, cacheKey); }
```

Any absolute path is accepted and handed to the analyzer. It will fail on a non-audio
file, but the failure message is returned to the caller (`:348`), which makes it a
filesystem probe. Unauthenticated today, per [C2](#c2--no-authentication-server-listens-on-all-interfaces).

**Suggested fix.** Gate behind the token from C2, and optionally confine local-file
analysis to a configured media root.

**Effort:** small.

---

### M7 — Prototype manipulation via `registerProfile`

**✅ Fixed.**

**Where:** `src/server/profiles.js:9,45`

```js
const fixtureProfiles = { [BUILTIN_PROFILE_ID]: { … } };   // plain object literal
// ...
fixtureProfiles[profile.id] = profile;                     // id fully user-controlled
```

`profileSchema` accepts any string id. Assigning `obj["__proto__"] = value` on a plain
object literal **reassigns the object's prototype** instead of creating a key, so a
profile posted with `id: "__proto__"` makes `getProfile()` (`:38-40`) return that object
for *every* unknown `profileId` — the built-in fallback stops working and fixtures render
against attacker-supplied channel maps.

Scope check: this corrupts the profile registry, not `Object.prototype` globally. Still
worth fixing, and cheap to fix.

**Suggested fix.** `Object.create(null)` or a `Map` for the registry, plus a reserved-id
rejection (`__proto__`, `constructor`, `prototype`) in `profileSchema`.

**Effort:** small.

---

### M8 — Zip-bomb / XML DoS on GDTF upload

**✅ Fixed.**

**Where:** `src/gdtf.js:65,79` and `src/server/routes.js:21`

```js
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
// ...
const zip = await JSZip.loadAsync(fileBuffer);
const xmlContent = await descFile.async('string');
```

The 50 MB compressed body is fully buffered in memory, then decompressed with no cap on
output size, then `description.xml` is materialised whole as a string. A crafted archive
turns a 50 MB upload into gigabytes of heap and takes the process down.

No XXE risk — `fast-xml-parser` does not resolve external entities.

**Suggested fix.** Cap decompressed size and bail past the limit; stream rather than
buffering; lower the limit on the GDTF route specifically (real GDTF files are well under
5 MB). The 50 MB limit is shared with `/api/auto/analyze-upload`, which genuinely needs
the headroom — give the two routes separate `multer` instances.

**Effort:** small.

---

### M9 — README documents a removed feature and the wrong MIDI map

**Where:** `README.md`

`grep -rn "aalink\|/api/link" src/ server.js public-src/ public/` returns **zero** hits,
yet the README documents Ableton Link as a headline feature across 8 places: a feature
bullet, a full setup section with `pip install aalink`, a `LINK=1` startup flag, a "Link
panel in the web UI", three `POST /api/link/{enable,disable,toggle}` endpoints, and a
`LINK` row in the config table. Only a comment at `src/prolink.js:9` ("like Ableton Link
did") remembers it existed. Someone following this README hits a dead end immediately.

Other inaccuracies:

| README says | Actual |
|---|---|
| Faders send Pitch Bend ch 1–9 | CC 1–9; `DEFAULT_MAP.pitchbend` is empty (`src/midi.js:44`) |
| Encoders on CC 1–7 | CC 10–17 (`src/midi.js:29-36`) |
| Button row 1 = notes 8–17 | Notes 16–23 (`src/midi.js:57-64`) |
| 13 colour presets, indices 0–12 | 24 |
| 10 patterns | 25 |

**Undocumented entirely** — everything added since: the auto-show engine, Spotify,
Deezer + the browser extension, PRO DJ LINK, SMTC now-playing, GDTF import, the analysis
cache and queue prefetch, `/api/show`, `/api/profiles`, `/api/auto/*`, and the env vars
`ARTNET_HOST`, `ARTNET_PORT`, `ARTNET_UNIVERSE`, `SPOTIFY_CLIENT_ID`,
`SPOTIFY_CLIENT_SECRET`, `SPOTIFY_PROXY_BASE`, `DEEZER_ARL`, `PROLINK`, `SMTC`.

**Suggested fix.** Rewrite against the current code. Add a `.env.example` — there is none
today, and roughly ten environment variables are needed for a full setup.

**Effort:** medium (writing, not code).

---

### M10 — `requirements.txt` cannot install the analyzer

**Where:** `requirements.txt`

Lists `librosa`, `numpy`, `scipy`, `scikit-learn`, `soundfile`, `yt-dlp`. The analyzer
also needs:

- `panns_inference` and `torch` — `src/essentia-analyze.py:64`
- `threadpoolctl` — `src/essentia-analyze.py:458`
- `ffmpeg` on `PATH` — `src/deezer.js:117`

Nothing is version-pinned.

The failure mode is the bad one: it fails **soft**. `src/essentia-analyze.py:64-66`
catches the missing import and prints `[panns] skipped: …` to stderr, so a fresh clone
produces quietly worse shows — no genre classification, so the palette and pattern
selection fall back to the circumplex defaults — with no visible error.

**Suggested fix.** Complete and pin the file, document the ffmpeg requirement, and make
`scripts/setup-panns.py --check` part of the documented setup so the degraded state is
detected rather than inferred.

**Effort:** small.

---

## 6. Low and nits

### L1 — Build artifacts and local config are committed

`git ls-files` shows three files that should not be tracked:

- `public/app.bundle.js` — regenerated by `scripts/build-client.js` on every `prestart`,
  so it drifts from `public-src/` and produces noisy diffs
- `src/__pycache__/essentia-analyze.cpython-312.pyc` — `.gitignore` has no `__pycache__`
  entry
- `.claude/settings.local.json` — machine-local tool permissions

**Fix:** add to `.gitignore`, `git rm --cached`. Note that untracking `app.bundle.js`
means anyone cloning must run the build — already handled by the `prestart` script, but
worth a README line.

### L2 — Font loaded from a CDN in a venue tool

`public/index.html:7-8` and `public/settings.html:7-8` load Inter from `https://rsms.me/`.
On a venue network with no internet the stylesheet request blocks until timeout and the
UI falls back to system fonts mid-setup. For a tool whose whole point is running on an
isolated lighting network, self-host the font files.

### L3 — MIDI monitor logging left enabled

`src/midi.js:167-176`, comment reads `── MIDI monitor (temporary) ──`. Logs every
`noteon`, `noteoff`, `cc` and `pitch` event. One encoder sweep floods stdout with
hundreds of lines. Put behind a `DEBUG_MIDI` env check.

### L4 — Art-Net sequence byte hardcoded to zero

`src/server/artnet.js:15` — `packet[12] = 0;`. Per the Art-Net spec, 0 explicitly tells
receivers that sequencing is disabled, so they cannot discard out-of-order UDP packets.
Increment 1→255 (wrapping, skipping 0) per universe.

### L5 — Socket `midi-connect` skips validation

`src/server/sockets.js:48-52` passes `input`/`output` straight to `midi.connect()`, while
the equivalent REST route validates with `midiConnectSchema` first
(`src/server/routes.js:142`). The schema already exists — apply it to both.

### L6 — No timeouts, size caps or redirect limit in the Deezer downloader

**✅ Fixed.**

`src/deezer.js:95-112`. `_downloadUrl` follows redirects by unbounded recursion (a
redirect loop recurses until it blows up), has no timeout, and buffers the entire track
into memory via `Buffer.concat`. Add a redirect cap, a timeout and a max size, or stream
to the temp file directly.

### L7 — Fixture addresses may overlap or run past channel 512

`fixtureMessageSchema` (`src/server/validation.js:63`) allows any address 1–512
independently per fixture, so two fixtures can be patched to the same address, and a
fixture at 505 with a 12-channel profile runs past the universe. `src/server/engine.js:135`
writes past the buffer end, which Node silently ignores — so it fails quietly rather than
loudly. The settings page detects overlap client-side (`public/settings.js:256-258`) but
the server accepts it regardless. Validate server-side.

### L8 — Dead code and stale comments

- `src/midi.js:236` — `ENERGY_IDS` declared and never used inside the `energyHold` branch
- `src/server/routes.js:8` — `getFixtureCount` imported, never used
- `src/midi.js:323` — comment says "Pattern buttons (notes 8-17)", actual notes are 16–25
  (`LED_PATTERNS`, `:78`); the colour comment at `:329` is off by the same amount
- `src/server/routes.js:300-301` — comment describes the old content-script CORS design
  that `browser-extension/background.js` replaced

A linter would catch the first two.

### L9 — No linter, formatter, CI or test runner

No `.eslintrc*`, no `eslint.config.*`, no `.prettierrc`, no `.github/`, and `package.json`
has no `test` script. `tests/real-track-analyze.js` is a manual script requiring network
access and a real track, not an automated test. Interestingly `companion-module/` *does*
have Prettier configured — the root project does not.

Worth having, in rough priority order: ESLint (would have caught L8 and flagged the
`innerHTML` sinks in C1 with `eslint-plugin-no-unsanitized`), a GitHub Actions workflow
running lint + `npm audit`, and unit tests for the pure logic that is genuinely testable
today — `buildArtDmxPacket`, the `keyFor*` builders in `src/analysis-cache.js`, the
`PATTERN_FUNCS` in `src/server/patterns.js`, and the zod schemas.

### L10 — Undocumented `--openssl-legacy-provider`

`package.json:9-10` passes it to both `start` and `dev` with no explanation. It re-enables
OpenSSL algorithms disabled for good reason. Identify what needs it (most likely
`prolink-connect`'s crypto), document it, and scope or remove it.

### L11 — Browser extension is Manifest V2 with a hardcoded port

`browser-extension/manifest.json:2` is `manifest_version: 2`, which Firefox is phasing
out. `browser-extension/background.js:7` hardcodes `http://localhost:3000`, so the
extension silently stops working if `PORT` is changed — with `.catch(() => {})` swallowing
the failure. Since it is in production use, it needs an MV3 migration plus an options page
for host, port and (after [C2](#c2--no-authentication-server-listens-on-all-interfaces))
the token.

Minor: `browser-extension/content.js:13` accepts any `window` message carrying
`__lsBridge: 'deezer'`, so any script on the Deezer page can forge snapshots. Low impact —
it only reaches a localhost server with track metadata — but worth knowing.

### L12 — `getClientState()` returns internal mutable objects

`src/server/state.js:70-97` returns `state.artnet`, `state.fixtures` and `listProfiles()`
by reference. Safe today only because everything is JSON-serialised on the way out. Any
future in-process consumer could mutate engine state by accident.

---

## 7. Feature proposals

Ideas rather than defects — listed separately so they do not compete with the fixes above.

- **Cue stack / scene snapshots.** Save and recall named looks. The state object is
  already a flat serialisable shape and `POST /api/show` defines a serialisation format,
  so this is mostly persistence plus a UI list.
- **MIDI learn.** `DEFAULT_MAP` (`src/midi.js:26-75`) is hardcoded to an X-Touch Compact.
  A learn mode writing to a JSON mapping file would open the tool to any controller.
- **Persist show state across restarts.** Fixtures, patch, profiles and Art-Net config are
  all lost on restart — including any GDTF profile imported during setup.
- **sACN (E1.31) output or Art-Net input.** Wider console compatibility; the packet
  builder is already isolated in `src/server/artnet.js`.
- **Multi-universe support.** `dmx` is a single 512-byte buffer (`src/server/state.js:50`),
  so fixtures cannot cross universes — a hard ceiling on rig size.
- **Pre-show preflight.** One command that verifies Art-Net reachability, Python deps,
  ffmpeg, yt-dlp and the PANNs checkpoint before doors open. Directly addresses the
  silent-degradation problem in [M10](#m10--requirementstxt-cannot-install-the-analyzer).
- **Playlist cache warming.** Pre-analyze a whole set list ahead of time instead of
  relying on live queue prefetch, which only looks 1–5 tracks ahead
  (`src/server/integrations.js:235`).

---

## 8. Suggested order of work

Grouped so each lands as a reviewable PR with a coherent theme.

**PR 1 — Security.** C1, C2, H2, H3, H5, M6, M7, M8. ✅ **Done** — implemented on this
branch, with the token wired through `companion-module/src/config.js` and the extension's
new options page.

**PR 2 — Stability.** H1, H4, M4, M5, L6. ✅ **Done.** H4 took the tree from 17
vulnerabilities (11 high) to **0**, via `npm audit fix`, Express 5, and `overrides` for
`cookie` and `ip-address` — the last two are pinned by `prolink-connect`, and the
`ip-address` bump was checked call-site by call-site against v7 first.

**PR 3 — Performance.** M1 and M2 together. ✅ **Done.** Measured on an idle rig:
**70.5 KB/s → 2.1 KB/s** per client (51 → 12 events in 5 s), and **800 → 200** component
renders over 10 s of a running show, the remaining 200 being the two views that actually
display DMX. Server CPU was never the problem — see the correction at the top.

**PR 4 — Hygiene and docs.** M3, M9, M10, the L-series, plus ESLint and a CI workflow.
Land ESLint first so it can catch L8 for you.
