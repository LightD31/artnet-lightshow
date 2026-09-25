import { InstanceBase, InstanceStatus } from '@companion-module/base'

import { GetConfigFields } from './config.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import { UpdatePresets } from './presets.js'
import { UpdateVariableDefinitions, UpdateVariableValues } from './variables.js'
import { LightshowConnection } from './connection.js'
import { CATALOG_KEYS } from './catalog.js'

export { UpgradeScripts } from './upgrades.js'

const STATUS = {
	connecting: InstanceStatus.Connecting,
	ok: InstanceStatus.Ok,
	disconnected: InstanceStatus.Disconnected,
	error: InstanceStatus.ConnectionFailure,
}

export default class ArtnetLightshowInstance extends InstanceBase {
	connection = null

	async init(config) {
		this.config = config
		this.#define()
		this.#connect()
	}

	async destroy() {
		this.#disconnect()
	}

	async configUpdated(config) {
		this.config = config
		this.#disconnect()
		this.#connect()
	}

	getConfigFields() {
		return GetConfigFields()
	}

	/** The server's state as last heard; empty until connected. */
	get liveState() {
		return this.connection ? this.connection.state : {}
	}

	// ── Socket connection ──────────────────────────────────────────────────────

	#connect() {
		if (!this.config.host) {
			this.updateStatus(InstanceStatus.BadConfig, 'No host configured')
			return
		}
		this.connection = new LightshowConnection({
			host: this.config.host,
			port: this.config.port || 3000,
			token: this.config.token || '',
			log: (level, message) => this.log(level, message),
			onStatus: (status, message) => {
				if (status === 'unauthorized') {
					this.updateStatus(InstanceStatus.BadConfig, 'Rejected: set the matching Access token in this connection\'s config')
					this.log('error', 'Lightshow server rejected the token — check the Access token field')
					return
				}
				if (status === 'ok') this.log('info', 'Connected to ArtNet Lightshow')
				this.updateStatus(STATUS[status] ?? InstanceStatus.UnknownWarning, message)
			},
			onChange: (keys) => {
				// Actions, feedbacks and presets list the server's patterns,
				// palettes, fixtures and cues: rebuilt when those change, not
				// on every tick of the BPM.
				if (CATALOG_KEYS.some((key) => keys.has(key))) this.#define()
				UpdateVariableValues(this)
				this.checkAllFeedbacks()
			},
		})
		this.log('debug', `Connecting to ${this.connection.base}`)
		this.connection.connect()
	}

	#disconnect() {
		if (this.connection) {
			this.connection.disconnect()
			this.connection = null
		}
	}

	#define() {
		UpdateActions(this)
		UpdateFeedbacks(this)
		UpdateVariableDefinitions(this)
		UpdatePresets(this)
	}

	// ── Message helpers used by actions ────────────────────────────────────────

	#connected() {
		if (this.connection) return this.connection
		this.log('warn', 'Not connected — action ignored')
		return null
	}

	sendSet(patch) {
		this.#connected()?.set(patch)
	}

	sendOverride(id, override) {
		this.#connected()?.override(id, override)
	}

	sendTap() {
		this.#connected()?.tap()
	}

	holdEnergy(effect) {
		this.#connected()?.holdEnergy(effect)
	}

	releaseEnergy() {
		this.connection?.releaseEnergy()
	}

	recallCue(id) {
		return this.#connected()?.recallCue(id)
	}

	autoShow(mode) {
		return this.#connected()?.autoShow(mode)
	}
}
