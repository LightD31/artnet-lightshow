// Domain versions detect missing patches so the caller can request a fresh snapshot.
export class StateStore {
	state = {}
	versions = null

	applySnapshot({ versions, state } = {}) {
		const keys = new Set([...Object.keys(this.state), ...Object.keys(state || {})])
		this.state = { ...(state || {}) }
		this.versions = { ...(versions || {}) }
		return keys
	}

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

	merge(values) {
		const keys = new Set(Object.keys(values || {}))
		Object.assign(this.state, values || {})
		return keys
	}
}
