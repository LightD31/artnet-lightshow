import { io } from 'socket.io-client'
import { StateStore } from './store.js'

// The server lets a held effect go 1.2 s after the last word from its holder
// (src/server/energy-hold.ts), so a Companion that crashes, or loses the
// network, with a button down cannot leave the rig strobing. Renewed well
// inside that.
const HOLD_RENEW_MS = 400
const REST_TIMEOUT_MS = 5000

/**
 * The link to one lightshow server: the socket, the state it keeps sending,
 * and the few things only its HTTP API does (recalling a cue, starting the
 * auto show). No Companion imports — the module's tests drive it against a
 * real server.
 *
 *   onStatus(status, message)  'connecting' | 'ok' | 'disconnected' | 'unauthorized' | 'error'
 *   onChange(keys)             the state keys an update touched (a Set)
 *   log(level, message)
 */
export class LightshowConnection {
	socket = null
	store = new StateStore()
	#hold = null
	#holdTimer = null
	#holdCount = 0

	#pads = new Map()

	constructor({ host, port = 3000, token = '', onStatus = () => {}, onChange = () => {}, log = () => {} }) {
		this.base = `http://${host}:${port}`
		this.token = token || ''
		this.onStatus = onStatus
		this.onChange = onChange
		this.log = log
	}

	get state() {
		return this.store.state
	}

	get connected() {
		return !!(this.socket && this.socket.connected)
	}

	connect() {
		this.onStatus('connecting')
		this.socket = io(this.base, {
			reconnection: true,
			reconnectionDelay: 2000,
			// Protocol 2: a snapshot, then only what changed.
			auth: { token: this.token, protocol: 2 },
		})
		this.socket.on('connect', () => this.onStatus('ok'))
		this.socket.on('disconnect', (reason) => {
			this.#stopRenewing()
			this.#releaseAllPads()
			this.onStatus('disconnected', reason)
		})
		this.socket.on('connect_error', (err) => {
			// A wrong or missing token comes back as code "unauthorized" in the
			// error's data, the message being for people. Said plainly: a
			// "connection failure" would send someone hunting a network problem
			// that is not there.
			this.onStatus(isUnauthorized(err) ? 'unauthorized' : 'error', err.message)
		})
		this.socket.on('error-msg', ({ source, message } = {}) => {
			this.log('warn', `Server rejected ${source || 'message'}: ${message}`)
		})
		this.socket.on('snapshot', (snapshot) => this.onChange(this.store.applySnapshot(snapshot)))
		this.socket.on('patch', (patch) => {
			const keys = this.store.applyPatch(patch)
			if (keys === 'stale') return
			if (keys === 'gap') {
				this.socket.emit('sync', (snapshot) => this.onChange(this.store.applySnapshot(snapshot)))
				return
			}
			this.onChange(keys)
		})
		// A server from before protocol 2 sends the whole state instead.
		this.socket.on('state', (state) => this.onChange(this.store.merge(state)))
	}

	// A pad held over REST: pressed once, then renewed within its 1200 ms
	// lease, each pad on a renewal of its own; release ends that one alone.
	// A once or a loop pad answers no hold to renew, and renewing stops, as it
	// does when the hold ended on the server or the socket drops.
	holdPad(bank, slot) {
		const key = `${bank}:${slot}`
		if (this.#pads.has(key)) return
		const body = { token: `companion:${key}` }
		const stop = () => {
			clearInterval(this.#pads.get(key))
			this.#pads.delete(key)
		}
		const renew = () =>
			this.post(`/api/pads/${bank}/${slot}/renew`, body)
				.then((answer) => {
					if (!answer || answer.renewed !== true) stop()
				})
				.catch(stop)
		// Held from now; renewed once the press is in, unless let go meanwhile.
		this.#pads.set(key, null)
		return this.post(`/api/pads/${bank}/${slot}/press`, body)
			.then((answer) => {
				if (!this.#pads.has(key)) return
				if (answer && answer.ok !== false) this.#pads.set(key, setInterval(renew, PAD_RENEW_MS))
				else stop()
			})
			.catch(stop)
	}

	releasePad(bank, slot) {
		const key = `${bank}:${slot}`
		clearInterval(this.#pads.get(key))
		this.#pads.delete(key)
		return this.post(`/api/pads/${bank}/${slot}/release`, { token: `companion:${key}` }).catch(() => {})
	}

	strobeBurst(ms) {
		return this.post(`/api/strobe/burst/${Math.round(ms)}`, {})
	}

	#releaseAllPads() {
		for (const timer of this.#pads.values()) clearInterval(timer)
		this.#pads.clear()
	}

	disconnect() {
		this.#releaseAllPads()
		this.#stopRenewing()
		if (this.socket) {
			this.socket.removeAllListeners()
			this.socket.disconnect()
			this.socket = null
		}
	}

	emit(event, ...args) {
		if (this.connected) {
			this.socket.emit(event, ...args)
			return true
		}
		this.log('warn', 'Not connected — action ignored')
		return false
	}

	set(patch) {
		return this.emit('set', patch)
	}

	override(id, override) {
		return this.emit('override', { id, override })
	}

	tap() {
		return this.emit('tap')
	}

	// ── Momentary effects ──────────────────────────────────────────────────────

	/** Hold an energy effect while a button is down (release with releaseEnergy). */
	holdEnergy(effect) {
		this.#stopRenewing()
		const token = `companion-${Date.now().toString(36)}-${++this.#holdCount}`
		if (!this.emit('energy-hold', { action: 'press', token, effect })) return false
		this.#hold = token
		this.#holdTimer = setInterval(() => {
			if (this.connected) this.socket.emit('energy-hold', { action: 'renew', token })
		}, HOLD_RENEW_MS)
		return true
	}

	/** Let go of the held effect, if this connection is holding one. */
	releaseEnergy() {
		const token = this.#hold
		this.#stopRenewing()
		if (token && this.connected) this.socket.emit('energy-hold', { action: 'release', token })
	}

	/** Is a button of this connection's holding an effect now? */
	get holding() {
		return this.#hold !== null
	}

	#stopRenewing() {
		if (this.#holdTimer) clearInterval(this.#holdTimer)
		this.#holdTimer = null
		this.#hold = null
	}

	// ── The HTTP API ───────────────────────────────────────────────────────────

	/** POST to the server's API, with the token. Resolves to its JSON answer. */
	post(path, body) {
		return this.request('POST', path, body)
	}

	/** Any method on the server's API, with the token. Resolves to its JSON answer, or `{ ok: false, error }`. */
	async request(method, path, body) {
		const res = await fetch(`${this.base}${path}`, {
			method,
			headers: { 'Content-Type': 'application/json', 'X-Lightshow-Token': this.token },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(REST_TIMEOUT_MS),
		})
		let answer
		try {
			answer = await res.json()
		} catch {
			answer = { ok: false, error: `the server answered ${res.status}` }
		}
		if (!res.ok || answer.ok === false) {
			const message = answer.error || `the server answered ${res.status}`
			this.log('warn', `${path}: ${message}`)
			return { ok: false, error: message }
		}
		return answer
	}

	recallCue(id) {
		return this.post(`/api/cues/${encodeURIComponent(id)}/recall`)
	}

	/** Put a palette over every effect until it is taken off (null takes it off). */
	paletteOverride(id) {
		return id ? this.request('PUT', '/api/palette-override', { paletteId: id }) : this.request('DELETE', '/api/palette-override')
	}

	/** Stop every running pad, effect and strobe. */
	stopEffects() {
		return this.request('DELETE', '/api/voices')
	}

	/** Start or stop the auto show; 'toggle' asks the state which. */
	autoShow(mode) {
		const on = mode === 'toggle' ? !this.state.showOn : mode === 'start'
		return this.post(on ? '/api/auto/start' : '/api/auto/stop')
	}

	/** Arm or disarm the outputs — whether anything leaves the machine; 'toggle' asks the state which. */
	armOutputs(mode) {
		const on = mode === 'toggle' ? !this.state.armed : mode === 'arm'
		return this.post(on ? '/api/outputs/arm' : '/api/outputs/disarm')
	}
}

// Well inside the server's 1200 ms hold lease.
const PAD_RENEW_MS = 400

/** The server's handshake refusal: the code in the error's data, or the bare word older servers sent. */
export function isUnauthorized(err) {
	return (err && err.data && err.data.code === 'unauthorized') || (err && err.message === 'unauthorized')
}
