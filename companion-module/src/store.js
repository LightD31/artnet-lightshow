/**
 * The server's state, as protocol 2 sends it: a snapshot on connecting, then
 * only the keys that changed, a domain at a time, each domain counting its
 * own versions (src/server/protocol.ts on the server, public-src/store.js in
 * the web page).
 *
 * Protocol 1 sent the whole state every time anything in it moved, several
 * times a second — every fixture, every profile, the auto show's analysis —
 * and with a WLED panel patched that was hundreds of kilobytes for a BPM
 * variable to tick. This keeps what arrives, and says which keys each update
 * touched so the module only rebuilds what they feed.
 *
 * No Companion imports: the module's tests run it on its own.
 */
export class StateStore {
	state = {}
	versions = null

	/** The whole state and the version each domain is at. Returns the keys it set. */
	applySnapshot({ versions, state } = {}) {
		const keys = new Set([...Object.keys(this.state), ...Object.keys(state || {})])
		this.state = { ...(state || {}) }
		this.versions = { ...(versions || {}) }
		return keys
	}

	/**
	 * One domain's changes. Returns the keys it touched, or 'stale' for one
	 * already seen, or 'gap' when one was missed (or no snapshot came yet): the
	 * caller then asks for a snapshot rather than drifting.
	 */
	applyPatch({ d, v, set, del } = {}) {
		if (!this.versions || !Number.isInteger(v)) return 'gap'
		const at = this.versions[d] ?? 0
		if (v <= at) return 'stale'
		if (v !== at + 1) return 'gap'
		const keys = new Set()
		for (const [key, value] of Object.entries(set || {})) {
			this.state[key] = value
			keys.add(key)
		}
		for (const key of del || []) {
			delete this.state[key]
			keys.add(key)
		}
		this.versions[d] = v
		return keys
	}

	/** A whole-state push from a server that only speaks protocol 1. */
	merge(values) {
		const keys = new Set(Object.keys(values || {}))
		Object.assign(this.state, values || {})
		return keys
	}
}
