import { InstanceBase, InstanceStatus } from '@companion-module/base'
import { io } from 'socket.io-client'

import { GetConfigFields } from './config.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import { UpdatePresets } from './presets.js'
import { UpdateVariableDefinitions, UpdateVariableValues } from './variables.js'

export { UpgradeScripts } from './upgrades.js'

export default class ArtnetLightshowInstance extends InstanceBase {
	socket = null
	liveState = {}

	async init(config) {
		this.config = config

		UpdateActions(this)
		UpdateFeedbacks(this)
		UpdateVariableDefinitions(this)
		UpdatePresets(this)

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

	// ── Socket connection ──────────────────────────────────────────────────────

	#connect() {
		if (!this.config.host) {
			this.updateStatus(InstanceStatus.BadConfig, 'No host configured')
			return
		}

		const url = `http://${this.config.host}:${this.config.port || 3000}`
		this.updateStatus(InstanceStatus.Connecting)
		this.log('debug', `Connecting to ${url}`)

		this.socket = io(url, {
			reconnection: true,
			reconnectionDelay: 2000,
			auth: { token: this.config.token || '' },
		})

		this.socket.on('connect', () => {
			this.updateStatus(InstanceStatus.Ok)
			this.log('info', 'Connected to ArtNet Lightshow')
		})

		this.socket.on('disconnect', (reason) => {
			this.updateStatus(InstanceStatus.Disconnected, reason)
		})

		this.socket.on('connect_error', (err) => {
			// The server rejects the handshake with "unauthorized" when it runs
			// with LIGHTSHOW_TOKEN set and this connection presented the wrong
			// token (or none). Say so plainly — "connection failure" would send
			// someone hunting a network problem that isn't there.
			if (err.message === 'unauthorized') {
				this.updateStatus(
					InstanceStatus.BadConfig,
					'Rejected: set the matching Access token in this connection\'s config',
				)
				this.log('error', 'Lightshow server rejected the token — check the Access token field')
				return
			}
			this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
		})

		this.socket.on('error-msg', ({ source, message } = {}) => {
			this.log('warn', `Server rejected ${source || 'message'}: ${message}`)
		})

		this.socket.on('state', (state) => {
			this.liveState = state || {}
			UpdateVariableValues(this)
			this.checkAllFeedbacks()
		})
	}

	#disconnect() {
		if (this.socket) {
			this.socket.removeAllListeners()
			this.socket.disconnect()
			this.socket = null
		}
	}

	// ── Message helpers used by actions ────────────────────────────────────────

	#emit(event, ...args) {
		if (this.socket && this.socket.connected) {
			this.socket.emit(event, ...args)
		} else {
			this.log('warn', 'Not connected — action ignored')
		}
	}

	sendSet(patch) {
		this.#emit('set', patch)
	}

	sendOverride(id, override) {
		this.#emit('override', { id, override })
	}

	sendTap() {
		this.#emit('tap')
	}
}
