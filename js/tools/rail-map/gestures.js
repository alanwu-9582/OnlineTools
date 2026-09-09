// Capture on the stable stage: the SVG is replaced during each pan/zoom.
export function bindGestures(stage, { getView, setView, pick, minScale, maxScale }) {
  const pointers = new Map();
  let baseline = null;
  let target = null;
  let moved = false;
  const snapshot = () => {
    const points = [...pointers.values()].slice(0, 2);
    if (!points.length) { baseline = null; return; }
    const [a, b = a] = points;
    baseline = {
      x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
      distance: Math.hypot(a.x - b.x, a.y - b.y), view: { ...getView() },
    };
  };
  const down = (event) => {
    if (event.button !== 0) return;
    if (!pointers.size) { target = event.target; moved = false; }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size > 1) moved = true;
    stage.setPointerCapture(event.pointerId);
    snapshot();
  };
  const move = (event) => {
    if (!pointers.has(event.pointerId) || !baseline) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const [a, b = a] = [...pointers.values()];
    const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
    if (!moved && Math.hypot(x - baseline.x, y - baseline.y) < 6) return;
    moved = true;
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    const ratio = baseline.distance > 0 ? distance / baseline.distance : 1;
    const scale = Math.max(minScale, Math.min(maxScale, baseline.view.scale * ratio));
    const box = stage.getBoundingClientRect();
    const wx = (baseline.x - box.left - baseline.view.tx) / baseline.view.scale;
    const wy = (baseline.view.ty - baseline.y + box.top) / baseline.view.scale;
    setView({ scale, tx: x - box.left - wx * scale, ty: y - box.top + wy * scale });
  };
  const end = (event) => {
    if (!pointers.has(event.pointerId)) return;
    if (event.type === "pointerup") move(event);
    if (event.type !== "pointerup") moved = true;
    pointers.delete(event.pointerId);
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    if (!pointers.size && !moved && target) pick({ target, clientX: event.clientX, clientY: event.clientY, pointerType: event.pointerType });
    snapshot();
  };
  const handlers = { pointerdown: down, pointermove: move, pointerup: end, pointercancel: end, lostpointercapture: end };
  for (const [name, handler] of Object.entries(handlers)) stage.addEventListener(name, handler);
  return () => {
    for (const [name, handler] of Object.entries(handlers)) stage.removeEventListener(name, handler);
    pointers.clear();
  };
}
