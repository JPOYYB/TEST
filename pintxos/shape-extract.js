/* shape-extract.js
   Transparent PNG alpha -> outer contour polygon for Matter.js
   Fix "floating sprite" by aligning sprite origin to alpha centroid via xOffset/yOffset.
   Public:
     - window.ShapeExtract.extract(imgPath, cfg)
     - window.ShapeExtract.makeBody(imgPath, x, y, opt)
*/

(function () {
  const cache = new Map(); // imgPath -> Promise<packed>

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function polygonArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += (p.x * q.y - q.x * p.y);
    }
    return a / 2;
  }

  // Moore neighbor tracing on boundary pixels (8-connected)
  function traceMoore(boundary, W, H, sx, sy) {
    const dirs = [
      { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 },
      { x: -1, y: 0 }, { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 }
    ];
    let x = sx, y = sy;
    let bx = sx - 1, by = sy; // backtrack
    const startX = x, startY = y;
    const out = [];

    const dirIndex = (dx, dy) => {
      for (let i = 0; i < dirs.length; i++) if (dirs[i].x === dx && dirs[i].y === dy) return i;
      return 0;
    };

    const safety = W * H * 10;
    let steps = 0;

    do {
      out.push({ x, y });

      const bi = dirIndex(x - bx, y - by);
      let found = false;

      for (let k = 0; k < 8; k++) {
        const idx = (bi + 1 + k) % 8;
        const nx = x + dirs[idx].x, ny = y + dirs[idx].y;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        if (boundary[ny * W + nx]) {
          const pb = (idx + 7) % 8;
          bx = x + dirs[pb].x; by = y + dirs[pb].y;
          x = nx; y = ny;
          found = true;
          break;
        }
      }

      if (!found) break;
      steps++;
      if (steps > safety) break;

    } while (!(x === startX && y === startY));

    return out;
  }

  function dist(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }

  // Closed polyline resampling: outputs exactly N points (stable; avoids DP breakage)
  function resampleClosed(points, N) {
    if (!points || points.length < 3) return points;

    // remove consecutive duplicates
    const ring = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const prev = ring[ring.length - 1];
      if (!prev || prev.x !== p.x || prev.y !== p.y) ring.push(p);
    }
    if (ring.length < 3) return ring;

    const M = ring.length;

    // perimeter
    const cum = [0];
    let perim = 0;
    for (let i = 0; i < M; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % M];
      perim += dist(a, b);
      cum.push(perim);
    }
    if (perim <= 1e-6) return ring;

    const step = perim / N;
    const out = [];
    let seg = 0;

    for (let k = 0; k < N; k++) {
      const target = k * step;

      while (seg < M && cum[seg + 1] < target) seg++;

      const a = ring[seg % M];
      const b = ring[(seg + 1) % M];
      const segLen = dist(a, b) || 1e-6;
      const segStart = cum[seg];
      const t = Math.min(1, Math.max(0, (target - segStart) / segLen));

      out.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t
      });
    }
    return out;
  }

  async function extract(imgPath, cfg = {}) {
    if (cache.has(imgPath)) return cache.get(imgPath);

    const p = (async () => {
      const img = await loadImage(imgPath);
      const iw = img.naturalWidth, ih = img.naturalHeight;

      const threshold = cfg.threshold ?? 20;      // ←薄い下端が欠けるなら下げる
