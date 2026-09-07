import { Regex } from '@companion-module/base'

export function GetConfigFields() {
	return [
		{
			type: 'static-text',
			id: 'info',
			label: 'Information',
			value: 'Connects to the ArtNet Lightshow server over Socket.IO. Start it with `npm start` in the project root.',
			width: 12,
		},
		{
			type: 'textinput',
			id: 'host',
			label: 'Lightshow server host',
			tooltip: 'Hostname or IP of the machine running the lightshow server',
			default: '127.0.0.1',
			width: 8,
			regex: Regex.HOSTNAME,
		},
		{
			type: 'number',
			id: 'port',
			label: 'Port',
			default: 3000,
			min: 1,
			max: 65535,
			width: 4,
		},
		{
			type: 'textinput',
			id: 'token',
			label: 'Access token',
			tooltip:
				'Only needed when the lightshow server runs with LIGHTSHOW_TOKEN set '
				+ '(required whenever it is bound to anything but localhost). Leave blank otherwise.',
			default: '',
			width: 12,
		},
	]
}
