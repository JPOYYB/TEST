/* shape-extract.js (SAFE)
   - Alpha contour extraction with robust fallbacks
   - Never breaks game even if getImageData() fails (CORS / SecurityError)
   - Fix "floating sprite" by aligning sprite origin to alpha centroid (xOffset/yOffset)
   Public:
     window.ShapeExtract.extract(imgPath, cfg)
     window.ShapeExtract.makeBody(imgPath, x, y, opt)
*/

(function () {
  const cache = new Map(); // imgPath -> Promise<packed|null>

  const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5);

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      // CORS OKならこれで getImageData が通る（ダメでも後段で落とさない）
      img.crossOrigin = "anonymous";
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
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  // closed polyline resampling to fixed N points (stable)
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
    const cum = [0];
    let perim = 0;

    for (let i = 0; i < M; i++) {
      perim += dist(ring[i], ring[(i + 1) % M]);
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

      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    return out;
  }

  async function extract(imgPath, cfg = {}) {
    if (cache.has(imgPath)) return cache.get(imgPath);

    const p = (async () => {
      try {
        const img = await loadImage(imgPath);
        const iw = img.naturalWidth, ih = img.naturalHeight;
        if (!iw || !ih) return null;

        const threshold = cfg.threshold ?? 20;
        const sampleScale = cfg.sampleScale ?? 0.35;
        const nPoints = cfg.nPoints ?? 160;

        const W = Math.max(32, Math.floor(iw * sampleScale));
        const H = Math.max(32, Math.floor(ih * sampleScale));
        const inv = 1 / sampleScale;

        const cvs = document.createElement("canvas");
        cvs.width = W; cvs.height = H;
        const ctx = cvs.getContext("2d", { willReadFrequently: true });
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(img, 0, 0, W, H);

        let imgData;
        try {
          imgData = ctx.getImageData(0, 0, W, H);
        } catch (e) {
          // CORS/SecurityError: ここで落とすとゲームが死ぬので null を返してフォールバックへ
          console.warn("[ShapeExtract] getImageData failed (CORS?) -> fallback:", imgPath, e);
          return null;
        }

        const data = imgData.data;
        const mask = new Uint8Array(W * H);

        // alpha centroid in downsample coords
        let solid = 0, sumX = 0, sumY = 0;
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

        // boundary map + start point
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

        const contour = traceMoore(boundary, W, H, sx, sy);
        if (!contour || contour.length < 30) return null;

        let pts = contour.map(p => ({ x: (p.x - cx) * inv, y: (p.y - cy) * inv }));
        pts = resampleClosed(pts, nPoints);
        if (!pts || pts.length < 10) return null;

        // ensure clockwise
        if (polygonArea(pts) > 0) pts.reverse();

        // sprite origin aligned to alpha centroid
        const cxOrig = cx * inv;
        const cyOrig = cy * inv;
        const xOffset = clamp01(cxOrig / iw);
        const yOffset = clamp01(cyOrig / ih);

        return { pts, iw, ih, xOffset, yOffset };
      } catch (e) {
        console.warn("[ShapeExtract] extract failed -> fallback:", imgPath, e);
        return null;
      }
    })();

    cache.set(imgPath, p);
    return p;
  }

  async function makeBody(imgPath, x, y, opt = {}) {
    const Matter = window.Matter;
    if (!Matter) throw new Error("Matter.js not loaded");

    const fallback = {
      pts: [
        { x: -60, y: -35 }, { x: 60, y: -35 }, { x: 80, y: 0 },
        { x: 60, y: 35 }, { x: -60, y: 35 }, { x: -80, y: 0 }
      ],
      iw: 160,
      ih: 90,
      xOffset: 0.5,
      yOffset: 0.5
    };

    let packed = null;
    try {
      packed = await extract(imgPath, opt.shapeCfg ?? {});
    } catch (e) {
      packed = null;
    }

    const { pts, iw, ih, xOffset, yOffset } = packed ?? fallback;

    const targetSize = opt.targetSize ?? 125;
    const hitInset = opt.hitInset ?? 0.98;
    const spriteScale = targetSize / Math.max(iw, ih);

    const bodyOpts = Object.assign({
      label: "Pintxo",
      restitution: 0.1,
      friction: 0.8
    }, opt.bodyOpts || {});

    let body = Matter.Bodies.fromVertices(x, y, [pts], bodyOpts, true);
    if (!body) body = Matter.Bodies.rectangle(x, y, targetSize, targetSize, bodyOpts);

    Matter.Body.scale(body, spriteScale * hitInset, spriteScale * hitInset);

    body.render = body.render || {};
    body.render.sprite = {
      texture: imgPath,
      xScale: spriteScale,
      yScale: spriteScale,
      xOffset: clamp01(xOffset),
      yOffset: clamp01(yOffset)
    };

    return body;
  }

  window.ShapeExtract = { extract, makeBody };
})();
