// Page side of the in-page export. Chrome 157+ (HTML-in-Canvas) and WebCodecs.
// The root element is re-parented into a "drawable" canvas and snapshotted once per frame, after the browser has painted it.
// The WebGL canvas is hidden from that snapshot and copied straight into the output instead: with WebGL inside the snapshot
// every frame costs roughly 4x more. Output order: backdrop, root background, WebGL canvas, everything else in the root.
window.__hicExport = (() => {
  let ov, octx, root, bg = null, glc, W, H, stream = null;
  // Chrome 157: a nested <canvas> in a drawable subtree is snapshotted without its left/top and border offsets.
  // Move the offset into a transform and turn the border into a ring shadow.
  const fixCanvases = el => { for (const c of el.querySelectorAll('canvas')) { if (c === glc) continue;
    const cs = getComputedStyle(c), bl = parseFloat(cs.borderLeftWidth) || 0, bt = parseFloat(cs.borderTopWidth) || 0;
    let x = c.offsetLeft, y = c.offsetTop; if (!x && !y && !bl && !bt) continue;
    if (bl || bt) { Object.assign(c.style, { border: '0', boxShadow: `0 0 0 ${bl}px ${cs.borderLeftColor}`, borderRadius: Math.max(0, (parseFloat(cs.borderTopLeftRadius) || 0) - bl) + 'px' }); x += bl; y += bt; }
    Object.assign(c.style, { left: '0px', top: '0px', right: 'auto', bottom: 'auto', transform: `translate(${x}px, ${y}px)` }); } };
  function setup(o) {
    root = document.querySelector(o.root); glc = o.gl ? document.querySelector(o.gl) : null; [W, H] = o.size; const [cw, ch] = o.css, cs = getComputedStyle(root);
    const box = `width:${cw}px;height:${ch}px`, hasBg = cs.backgroundImage !== 'none' || cs.backgroundColor !== 'rgba(0, 0, 0, 0)', bgCss = cs.background;
    // the drawable canvas takes the root's place in the page; the root keeps its own layout inside it, pinned to its css size
    ov = document.createElement('canvas'); ov.setAttribute('content', 'drawable'); ov.width = W; ov.height = H;
    ov.style.cssText = `display:block;${box};position:${cs.position === 'static' ? 'relative' : cs.position};left:${cs.left};top:${cs.top};right:${cs.right};bottom:${cs.bottom};margin:${cs.margin}`;
    root.parentNode.insertBefore(ov, root); ov.appendChild(root); root.setAttribute('drawable', '');
    const pin = (el, props) => { for (const k in props) el.style.setProperty(k, props[k], 'important'); };     // must win over the page's own !important rules
    pin(root, { position: 'absolute', left: '0px', top: '0px', right: 'auto', bottom: 'auto', margin: '0', width: cw + 'px', height: ch + 'px', 'box-sizing': 'border-box' });
    if (glc) { pin(glc, { visibility: 'hidden' });                             // out of the snapshot; drawImage still reads its pixels
      if (hasBg) { bg = document.createElement('div'); bg.setAttribute('drawable', ''); bg.style.cssText = `position:absolute;left:0;top:0;${box};background:${bgCss}`; ov.insertBefore(bg, root); pin(root, { background: 'transparent' }); } }
    fixCanvases(root);                                                          // reads layout, so it runs after re-parenting
    octx = ov.getContext('2d'); octx.fillStyle = o.backdrop || '#000';
  }
  const painted = () => new Promise(r => { ov.addEventListener('paint', r, { once: true }); ov.requestPaint(); });
  async function frame(n) {
    window.__adapter.renderFrame(n); await painted();                         // drawing before the paint event returns the previous frame's DOM
    octx.fillRect(0, 0, W, H);                                                // the page backdrop, in case the frame is translucent
    if (bg) octx.drawElementImage(bg, 0, 0, W, H);
    if (glc) octx.drawImage(glc, 0, 0, W, H);
    octx.drawElementImage(root, 0, 0, W, H);
    return ov;
  }
  async function encode({ from, count, fps, bitrate, keep, hardware = true }) {
    const parts = []; let bytes = 0, err = null, waits = 0;
    const enc = new VideoEncoder({ output: ch => { bytes += ch.byteLength; if (keep) { const u = new Uint8Array(ch.byteLength); ch.copyTo(u); parts.push(u); } }, error: e => { err = String(e); } });
    const cfg = { codec: 'avc1.64002A', width: W, height: H, bitrate, framerate: fps, hardwareAcceleration: hardware ? 'prefer-hardware' : 'prefer-software', latencyMode: 'quality', avc: { format: 'annexb' } };
    if (!(await VideoEncoder.isConfigSupported(cfg)).supported) return { err: 'H.264 High 4.2 at this size is not supported by this browser\'s encoder' };
    enc.configure(cfg);
    const t0 = performance.now();
    for (let n = from; n < from + count && !err; n++) {
      const vf = new VideoFrame(await frame(n), { timestamp: Math.round((n - from)*1e6/fps), duration: Math.round(1e6/fps) });
      enc.encode(vf, { keyFrame: (n - from) % (2*fps) === 0 }); vf.close();
      // back-pressure on the encoder's own event: nested timers are clamped to 4 ms
      while (enc.encodeQueueSize > 8) { waits++; await new Promise(r => enc.addEventListener('dequeue', r, { once: true })); }
    }
    await enc.flush().catch(e => { err = String(e); }); enc.close();
    const ms = performance.now() - t0;
    if (keep && !err) { stream = new Uint8Array(bytes); let o = 0; for (const p of parts) { stream.set(p, o); o += p.length; } }
    return { err, ms, bytes, waits };
  }
  // hand the encoded stream to the driver in pieces (base64 over the DevTools connection)
  const slice = (a, b) => { const u = stream.subarray(a, b), out = []; for (let k = 0; k < u.length; k += 24576) out.push(btoa(String.fromCharCode.apply(null, u.subarray(k, k + 24576)))); return out.join(''); };
  const png = async n => (await frame(n)).toDataURL('image/png').split(',')[1];
  return { setup, frame, encode, png, slice };
})();
