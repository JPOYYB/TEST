/* shape-extract.js
   Use: ShapeExtract.makeBody(texturePath, x, y, { maskPath, targetSize, hitInset, shapeCfg, bodyOpts })
   - silhouette from maskPath (PNG with hard alpha)
   - render sprite from texturePath
*/

(function () {
  const cache = new Map();
  const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5);

  function ensureDecomp() {
    try {
      if (window.Matter && window.decomp && window.Matter?.Common?.setDecomp) {
        window.Matter.Common.setDecomp(window.decomp);
      }
    } catch (_) {}
  }

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

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function resampleClosed(points, N) {
    if (!points || points.length < 3) return points;

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

  // Moore neighbor tracing boundary (8-connected)
  function traceMoore(boundary, W, H, sx, sy) {
    const dirs = [
      { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 },
      { x: -1, y: 0 }, { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 }
    ];
    const dirIndex = (dx, dy) => {
      for (let i = 0; i < dirs.length; i++) if (dirs[i].x === dx && dirs[i].y === dy) return i;
      return 0;
    };

    let x = sx, y = sy;
    let bx = sx - 1, by = sy;
    const startX = x, startY = y;

    const out = [];
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
          bx = x + dirs[pb].x;
          by = y + dirs[pb].y;
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

  async function extract(maskPath, cfg = {}) {
    if (cache.has(maskPath)) return cache.get(maskPath);

    const p = (async () => {
      try {
        const img = await loadImage(maskPath);
        const iw = img.naturalWidth, ih = img.naturalHeight;
        if (!iw || !ih) return null;

        const threshold = cfg.threshold ?? 5;       // マスクは硬いので低めでOK
        const sampleScale = cfg.sampleScale ?? 0.5; // マスクは少し高解像で取ると精度上がる
        const nPoints = cfg.nPoints ?? 180;

        const W = Math.max(48, Math.floor(iw * sampleScale));
        const H = Math.max(48, Math.floor(ih * sampleScale));
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
          console.warn("[ShapeExtract] getImageData failed:", maskPath);
          return null;
        }

        const data = imgData.data;
        const mask = new Uint8Array(W * H);

        let solid = 0, sumX = 0, sumY = 0;
        let minX = W, minY = H, maxX = -1, maxY = -1;

        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            const a = data[i + 3];
            if (a > threshold) {
              mask[y * W + x] = 1;
              solid++;
              sumX += x; sumY += y;
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (solid < 80) return null;

        const cx = sumX / solid;
        const cy = sumY / solid;

        // boundary
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
        if (!contour || contour.length < 40) return null;

        let pts = contour.map(p => ({ x: (p.x - cx) * inv, y: (p.y - cy) * inv }));
        pts = resampleClosed(pts, nPoints);
        if (!pts || pts.length < 20) return null;

        if (polygonArea(pts) > 0) pts.reverse(); // clockwise

        const bw = Math.max(1, (maxX - minX + 1) * inv);
        const bh = Math.max(1, (maxY - minY + 1) * inv);

        const xOffset = clamp01((cx * inv) / iw);
        const yOffset = clamp01((cy * inv) / ih);

        return { pts, iw, ih, bw, bh, xOffset, yOffset };
      } catch (e) {
        console.warn("[ShapeExtract] extract failed:", maskPath, e);
        return null;
      }
    })();

    cache.set(maskPath, p);
    return p;
  }

  async function makeBody(texturePath, x, y, opt = {}) {
    const Matter = window.Matter;
    if (!Matter) throw new Error("Matter.js not loaded");

    ensureDecomp();

    const maskPath = opt.maskPath ?? texturePath;
    const packed = await extract(maskPath, opt.shapeCfg ?? {});

    // fallback
    const fb = {
      pts: [
        { x: -60, y: -35 }, { x: 60, y: -35 }, { x: 80, y: 0 },
        { x: 60, y: 35 }, { x: -60, y: 35 }, { x: -80, y: 0 }
      ],
      iw: 160, ih: 90,
      bw: 160, bh: 90,
      xOffset: 0.5, yOffset: 0.5
    };

    const use = packed ?? fb;
    if (!packed) console.warn("[ShapeExtract] FALLBACK used:", maskPath);

    const targetSize = opt.targetSize ?? 125;
    const hitInset = opt.hitInset ?? 0.97; // マスクなら 0.95〜0.99 で調整
    const spriteScale = targetSize / Math.max(use.bw, use.bh);

    const bodyOpts = Object.assign({
      label: "Pintxo",
      restitution: 0.05,
      friction: 0.9
    }, opt.bodyOpts || {});

    let body = null;
    try {
      body = Matter.Bodies.fromVertices(x, y, [use.pts], bodyOpts, true);
    } catch (e) {
      console.warn("[ShapeExtract] fromVertices failed:", e);
      body = null;
    }
    if (!body) body = Matter.Bodies.rectangle(x, y, targetSize, targetSize, bodyOpts);

    Matter.Body.scale(body, spriteScale * hitInset, spriteScale * hitInset);

    body.render = body.render || {};
    body.render.sprite = {
      texture: texturePath,
      xScale: spriteScale,
      yScale: spriteScale,
      xOffset: use.xOffset,
      yOffset: use.yOffset
    };

    return body;
  }

  window.ShapeExtract = { extract, makeBody };
})();
