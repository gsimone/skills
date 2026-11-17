// Adapter: everything the exporter needs to know about one page.
// The driver reads the plain fields. The three functions run INSIDE the page: they are sent as source text,
// so they must be self-contained (page globals are fine, variables from this file are not).
//
// Worked example, for a page that keeps a global clock `T`, exposes `renderAt(scene, t)` and loops on requestAnimationFrame:
//
//   prepare: () => { playing = false; window.__render = window.renderAt; window.renderAt = () => {}; },
//   renderFrame: n => { T = Math.min(n/60, TOTAL - 1e-3); const [i, lt] = locate(T); window.__render(i, lt); },
//   frames: () => Math.round(TOTAL*60),
//
// and it was opened as `page.html?rs=1.5#fur`, a switch added to a copy of the page so its WebGL canvas renders at 1920x1080.

export default {
  root: '#stage',            // the element whose box is the video frame
  gl: '#gl',                 // the WebGL canvas that fills the root and sits below everything else in it; omit for a page without one
  css: [1280, 720],          // the root's size in CSS pixels
  size: [1920, 1080],        // output size in pixels; same aspect ratio as css (the driver sets the device scale factor to size/css)
  fps: 60,

  // total frame count: a number, or a function evaluated in the page
  frames: () => Math.round(DURATION_SECONDS*60),

  // runs once in the page after load and fonts: stop the page's own animation loop, set initial state. May be async.
  prepare: () => {},

  // draws frame n synchronously; the picture must depend only on n
  renderFrame: n => { /* seek the page to n/60 seconds and draw */ },

  // Optional.
  // backdrop: '#000',        // colour behind the root, visible where the root is translucent (default black)
  // viewport: [1480, 900],   // browser viewport in CSS pixels (default: css). Enlarge when the page lays the root out smaller than css otherwise.
  // pageCss: `...`,          // CSS injected after load. The screenshot paths (verify's reference, screenshot-export) need the root at its
  //                          // natural size and fully visible: use this to drop page padding, hide controls, undo responsive scaling.
};
