/* shape-extract.js
   - Transparent PNG alpha -> outer contour polygon
   - centroid from alpha area (not bbox)
   - closed-curve resampling (stable)
   - provides: window.ShapeExtract.makeBody(...)
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

  // Closed polyline resampling: outputs exactly N points (stable, no DP destruction)
  function resampleClosed(points, N) {
    if (!points || points.length < 3) return points;
    // remove consecutive duplicates
    const pts = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const prev = pts[pts.length - 1];
      if (!prev || prev.x !== p.x || prev.y !== p.y) pts.push(p);
    }
    if (pts.length < 3) return pts;

    // ensure closed by not duplicating last=first; we will treat as ring
    const ring = pts.slice();
    const M = ring.length;

    // cumulative perimeter
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
    let target = 0;
    let seg = 0;

    for (let k = 0; k < N; k++) {
      target = k * step;

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

  async function extract(imgPath, cfg) {
    // cache as Promise to avoid duplicated work
    if (cache.has(imgPath)) return cache.get(imgPath);

    const p = (async () => {
      const img = await loadImage(imgPath);
      const iw = img.naturalWidth, ih = img.naturalHeight;

      const threshold = cfg.threshold ?? 25;
      const sampleScale = cfg.sampleScale ?? 0.35;

      const W = Math.max(32, Math.floor(iw * sampleScale));
      const H = Math.max(32, Math.floor(ih * sampleScale));

      const cvs = document.createElement("canvas");
      cvs.width = W; cvs.height = H;
      const ctx = cvs.getContext("2d", { willReadFrequently: true });
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0, W, H);

      const data = ctx.getImageData(0, 0, W, H).data;
      const mask = new Uint8Array(W * H);

      // centroid (area-weighted) in downsample coords
      let solid = 0;
      let sumX = 0, sumY = 0;

      // boundary start candidate = topmost-leftmost boundary pixel
      // compute mask first
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const a = data[i + 3];
          if (a > threshold) {
            mask[y * W + x] = 1;
            solid++;
            sumX += x;
            sumY += y;
          }
        }
      }
      if (solid < 50) return null;

      const cx = sumX / solid;
      const cy = sumY / solid;

      // boundary map
      const boundary = new Uint8Array(W * H);
      let sx = -1, sy = -1;
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const idx = y * W + x;
          if (!mask[idx]) continue;
          if (!mask[idx - 1] || !mask[idx + 1] || !mask[idx - W] || !mask[idx + W]) {
            boundary[idx] = 1;
            if (sy === -1 || y < sy || (y === sy && x < sx)) { sx = x; sy = y; }
          }
        }
      }
      if (sx === -1) return null;

      // trace outer contour
      const contour = traceMoore(boundary, W, H, sx, sy);
      if (!contour || contour.length < 30) return null;

      // convert to original pixel coords centered by centroid
      const inv = 1 / sampleScale;
      let pts = contour.map(p => ({
        x: (p.x - cx) * inv,
        y: (p.y - cy) * inv
      }));

      // Stable simplification: resample to fixed point count
      const nPoints = cfg.nPoints ?? 140;
      pts = resampleClosed(pts, nPoints);

      // avoid degenerate
      if (!pts || pts.length < 10) return null;

      // ensure clockwise for Matter stability
      if (polygonArea(pts) > 0) pts.reverse();

      return { pts, iw, ih };
    })();

    cache.set(imgPath, p);
    return p;
  }

  // Public: create Matter body from image path using extracted contour
  async function makeBody(imgPath, x, y, opt = {}) {
    const Matter = window.Matter;
    if (!Matter) throw new Error("Matter.js not loaded");

    const cfg = opt.shapeCfg ?? {};
    const packed = await extract(imgPath, cfg);

    const fallback = {
      pts: [
        { x: -50, y: -35 }, { x: 50, y: -35 }, { x: 70, y: 0 },
        { x: 50, y: 35 }, { x: -50, y: 35 }, { x: -70, y: 0 }
      ],
      iw: 140,
      ih: 90
    };

    const { pts, iw, ih } = packed ?? fallback;

    const targetSize = opt.targetSize ?? 120;  // final on-screen size (px-ish)
    const hitInset = opt.hitInset ?? 0.95;     // shrink collider a bit to avoid "air hit"
    const spriteScale = targetSize / Math.max(iw, ih);

    const bodyOpts = Object.assign({
      label: "Pintxo",
      restitution: 0.1,
      friction: 0.8
    }, opt.bodyOpts || {});

    // create body from vertices
    let body = Matter.Bodies.fromVertices(x, y, [pts], bodyOpts, true);

    // If fromVertices fails (rare), fallback to rectangle
    if (!body) {
      body = Matter.Bodies.rectangle(x, y, targetSize, targetSize, bodyOpts);
    }

    // scale collider to match sprite scale (+ inset)
    Matter.Body.scale(body, spriteScale * hitInset, spriteScale * hitInset);

    // sprite render
    body.render = body.render || {};
    body.render.sprite = {
      texture: imgPath,
      xScale: spriteScale,
      yScale: spriteScale
    };

    return body;
  }

  window.ShapeExtract = {
    extract,
    makeBody
  };
})();
