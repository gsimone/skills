import React, { useEffect, useRef, useState } from 'react'
import { useEditor } from 'tldraw'

const h = React.createElement
const panelStyle = {
	position: 'absolute',
	right: 16,
	bottom: 16,
	width: 'min(420px, calc(100% - 32px))',
	minWidth: 300,
	maxWidth: 'calc(100% - 32px)',
	resize: 'horizontal',
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
	const iframeRef = useRef(null)
	const seekRef = useRef(() => {})
	const [source, setSource] = useState(() => sourceFromCanvas(editor))
	const [collapsed, setCollapsed] = useState(false)
	const [current, setCurrent] = useState({ start: 0, title: '' })

	useEffect(() => {
		const update = () => setSource(sourceFromCanvas(editor))
		update()
		return editor.store.listen(update)
	}, [editor])

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

	return h(
		'div',
		{
			style: panelStyle,
			onPointerDown: stopCanvasEvent,
			onWheel: stopCanvasEvent,
			'data-youtube-canvas-player': source.videoId,
			'data-youtube-canvas-start': String(current.start),
			'data-youtube-canvas-title': current.title || source.title,
		},
		h(
			'div',
			{ style: headerStyle },
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
