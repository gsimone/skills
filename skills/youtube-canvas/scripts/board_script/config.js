import React from 'react'
import { YouTubeCanvasPlayer } from './youtubePlayer.js'

const h = React.createElement

/** @param {import('../.script-workspace/script-context').ConfigScriptContext} ctx */
export default function ({ config }) {
	const ExistingInFrontOfTheCanvas = config.components.InFrontOfTheCanvas

	function InFrontOfTheCanvas() {
		return h(
			React.Fragment,
			null,
			ExistingInFrontOfTheCanvas ? h(ExistingInFrontOfTheCanvas) : null,
			h(YouTubeCanvasPlayer)
		)
	}

	config.components = {
		...config.components,
		InFrontOfTheCanvas,
	}
	return config
}
