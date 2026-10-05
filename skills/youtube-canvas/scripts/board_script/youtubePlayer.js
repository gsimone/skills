import React, { useEffect, useRef, useState } from 'react'
import { useEditor } from 'tldraw'

const h = React.createElement
const panelStyle = {
	position: 'absolute',
	minWidth: 300,
	maxWidth: 'calc(100% - 32px)',
	borderRadius: 12,
	overflow: 'hidden',
	background: '#111',
	color: '#fff',
	boxShadow: '0 16px 48px rgba(0, 0, 0, 0.35)',
	pointerEvents: 'auto',
	fontFamily: 'Inter, system-ui, sans-serif',
}
const headerStyle = {
	display: 'flex',
	alignItems: 'center',
	gap: 8,
	minHeight: 42,
	padding: '7px 8px 7px 12px',
	background: '#18181b',
}
const buttonStyle = {
	border: 0,
	borderRadius: 7,
	padding: '6px 9px',
	background: '#303036',
	color: '#fff',
	cursor: 'pointer',
	font: 'inherit',
	fontSize: 12,
}

function sourceFromCanvas(editor) {
	const shape = editor
		.getCurrentPageShapes()
		.find((candidate) => candidate.meta?.youtubeCanvas?.kind === 'player')
	const marker = shape?.meta?.youtubeCanvas
	if (!shape || !marker?.videoId) return null
	return {
		videoId: marker.videoId,
		title: marker.title || 'YouTube research video',
		url: marker.url || shape.props?.url || `https://youtu.be/${marker.videoId}`,
	}
}

function playerCommand(iframe, func, args = []) {
	iframe?.contentWindow?.postMessage(
		JSON.stringify({ event: 'command', func, args }),
		'*'
	)
}

export function YouTubeCanvasPlayer() {
	const editor = useEditor()
	const panelRef = useRef(null)
	const iframeRef = useRef(null)
	const seekRef = useRef(() => {})
	const interactionRef = useRef(null)
	const [source, setSource] = useState(() => sourceFromCanvas(editor))
	const [collapsed, setCollapsed] = useState(false)
	const [current, setCurrent] = useState({ start: 0, title: '' })
	const [placement, setPlacement] = useState({ left: null, top: null, width: 420 })

	useEffect(() => {
		const update = () => setSource(sourceFromCanvas(editor))
		update()
		return editor.store.listen(update)
	}, [editor])

	useEffect(() => {
		function handlePointerMove(event) {
			const interaction = interactionRef.current
			if (!interaction) return
			if (interaction.kind === 'move') {
				const left = Math.max(
					8,
					Math.min(
						window.innerWidth - interaction.width - 8,
						interaction.left + event.clientX - interaction.clientX
					)
				)
				const top = Math.max(
					8,
					Math.min(
						window.innerHeight - interaction.height - 8,
						interaction.top + event.clientY - interaction.clientY
					)
				)
				setPlacement({ left, top, width: interaction.width })
				return
			}

			const maxWidth = Math.min(900, interaction.right - 8)
			const width = Math.max(
				300,
				Math.min(maxWidth, interaction.width - (event.clientX - interaction.clientX))
			)
			setPlacement({ left: interaction.right - width, top: interaction.top, width })
		}

		function handlePointerUp() {
			interactionRef.current = null
		}

		window.addEventListener('pointermove', handlePointerMove)
		window.addEventListener('pointerup', handlePointerUp)
		return () => {
			window.removeEventListener('pointermove', handlePointerMove)
			window.removeEventListener('pointerup', handlePointerUp)
		}
	}, [])

	seekRef.current = (start, title) => {
		setCollapsed(false)
		setCurrent({ start, title: title || '' })
		playerCommand(iframeRef.current, 'seekTo', [start, true])
		playerCommand(iframeRef.current, 'playVideo')
	}

	useEffect(() => {
		function handleEvent(info) {
			if (info?.name !== 'pointer_down') return
			const point = editor.inputs?.currentPagePoint
			if (!point) return
			const shape = editor.getShapeAtPoint(point, { hitInside: true })
			const marker = shape?.meta?.youtubeCanvas
			if (marker?.kind !== 'timestamp') return
			seekRef.current(Number(marker.start) || 0, marker.title)
		}
		editor.on('event', handleEvent)
		return () => editor.off('event', handleEvent)
	}, [editor])

	if (!source) return null

	const watchUrl = `https://youtu.be/${source.videoId}?t=${Math.max(0, Math.floor(current.start))}`
	const embedUrl = `https://www.youtube-nocookie.com/embed/${source.videoId}?enablejsapi=1&playsinline=1&rel=0`
	const stopCanvasEvent = (event) => event.stopPropagation()
	const beginMove = (event) => {
		if (event.button !== 0 || event.target.closest('button, a')) return
		event.preventDefault()
		event.stopPropagation()
		const rect = panelRef.current.getBoundingClientRect()
		interactionRef.current = {
			kind: 'move',
			clientX: event.clientX,
			clientY: event.clientY,
			left: rect.left,
			top: rect.top,
			width: rect.width,
			height: rect.height,
		}
	}
	const beginResize = (event) => {
		if (event.button !== 0) return
		event.preventDefault()
		event.stopPropagation()
		const rect = panelRef.current.getBoundingClientRect()
		interactionRef.current = {
			kind: 'resize',
			clientX: event.clientX,
			right: rect.right,
			top: rect.top,
			width: rect.width,
		}
		setPlacement({ left: rect.left, top: rect.top, width: rect.width })
	}

	return h(
		'div',
		{
			ref: panelRef,
			style: {
				...panelStyle,
				width: placement.width,
				left: placement.left === null ? undefined : placement.left,
				top: placement.top === null ? undefined : placement.top,
				right: placement.left === null ? 16 : undefined,
				bottom: placement.top === null ? 16 : undefined,
			},
			onPointerDown: stopCanvasEvent,
			onWheel: stopCanvasEvent,
			'data-youtube-canvas-player': source.videoId,
			'data-youtube-canvas-start': String(current.start),
			'data-youtube-canvas-title': current.title || source.title,
			'data-youtube-canvas-left': placement.left === null ? 'auto' : String(placement.left),
			'data-youtube-canvas-top': placement.top === null ? 'auto' : String(placement.top),
			'data-youtube-canvas-width': String(placement.width),
		},
		h(
			'div',
			{
				style: { ...headerStyle, cursor: 'grab', userSelect: 'none' },
				onPointerDown: beginMove,
				'data-youtube-canvas-drag-handle': true,
				title: 'Drag to move the video player',
			},
			h(
				'span',
				{
					style: {
						display: 'grid',
						placeItems: 'center',
						width: 28,
						height: 28,
						borderRadius: 7,
						background: '#303036',
						color: '#fff',
						cursor: 'ew-resize',
						fontSize: 15,
						flex: '0 0 auto',
					},
					onPointerDown: beginResize,
					'data-youtube-canvas-resize-handle': true,
					title: 'Drag left or right to resize the video player',
				},
				'↔'
			),
			h(
				'span',
				{
					style: { color: '#a1a1aa', fontSize: 16, lineHeight: 1 },
					'aria-hidden': true,
				},
				'⠿'
			),
			h(
				'div',
				{
					style: {
						flex: 1,
						minWidth: 0,
						whiteSpace: 'nowrap',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						fontSize: 12,
						fontWeight: 600,
					},
				title: current.title || source.title,
			},
			current.title || source.title
		),
		h(
			'a',
			{
				href: watchUrl,
				target: '_blank',
				rel: 'noreferrer',
				style: { ...buttonStyle, textDecoration: 'none' },
				title: 'Open this moment on YouTube',
			},
			'YouTube ↗'
		),
		h(
			'button',
			{
				type: 'button',
				style: buttonStyle,
				onClick: () => setCollapsed((value) => !value),
				'aria-label': collapsed ? 'Expand video player' : 'Collapse video player',
			},
			collapsed ? 'Watch' : '—'
		)
		),
		collapsed
			? null
			: h('iframe', {
				ref: iframeRef,
				src: embedUrl,
				title: source.title,
				style: { display: 'block', width: '100%', aspectRatio: '16 / 9', border: 0 },
				allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
				allowFullScreen: true,
			})
	)
}
