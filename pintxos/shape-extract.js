/* shape-extract.js (dbg-v2-crop 2)
 * - Extract contour from mask/alpha
 * - Compute bbox of solid pixels
 * - Return verts in CROPPED coordinate space + centroid-based spriteOffset
 * - Never hangs (timeouts), returns meta for debugging
 */
(function (global) {
  "use strict";

  const ShapeExtract = {};

  function nowMs() { return (performance && performance.now) ? performance.now() : Date.now(); }
  function logPush(logger, msg) { if (logger) logger.push({ t: nowMs(), msg }); }

  function withTimeout(promise, ms, label) {
    let t;
    const timeout = new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`timeout:${label}`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
  }

  function loadImage(url, timeoutMs = 8000) {
    return withTimeout(new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`img load error: ${url}`));
      img.src = url;
    }), timeoutMs, `loadImage ${url}`);
  }

  function createCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }

  function dilate(bin, w, h, iters) {
    let src = bin;
    for (let k = 0; k < iters; k++) {
      const dst = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let v = 0;
          for (let dy = -1; dy <= 1 && !v; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= w) continue;
              if (src[yy * w + xx]) { v = 1; break; }
            }
          }
          dst[y * w + x] = v;
        }
      }
      src = dst;
    }
    bin.set(src);
  }

  // Marching squares (tl=1,tr=2,br=4,bl=8)
  const MS_TABLE = {
    0: [],
    1: [["top", "left"]],
    2: [["right", "top"]],
    3: [["right", "left"]],
    4: [["bottom", "right"]],
    5: [["top", "left"], ["bottom", "right"]],
    6: [["bottom", "top"]],
    7: [["bottom", "left"]],
    8: [["left", "bottom"]],
    9: [["top", "bottom"]],
    10: [["left", "top"], ["right", "bottom"]],
    11: [["right", "bottom"]],
    12: [["left", "right"]],
    13: [["top", "right"]],
    14: [["left", "top"]],
    15: []
  };

  function edgePoint(edge, x, y) {
    switch (edge) {
      case "left": return [x, y + 0.5];
      case "right": return [x + 1, y + 0.5];
      case "top": return [x + 0.5, y];
      case "bottom": return [x + 0.5, y + 1];
      default: return [x + 0.5, y + 0.5];
    }
  }
  function keyPt(p) { return `${p[0].toFixed(3)},${p[1].toFixed(3)}`; }

  function buildContourFromBinary(bin, w, h, logger) {
    const segs = [];
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        const tl = bin[y * w + x] ? 1 : 0;
        const tr = bin[y * w + (x + 1)] ? 1 : 0;
        const br = bin[(y + 1) * w + (x + 1)] ? 1 : 0;
        const bl = bin[(y + 1) * w + x] ? 1 : 0;
        const idx = (tl ? 1 : 0) | (tr ? 2 : 0) | (br ? 4 : 0) | (bl ? 8 : 0);
        const pairs = MS_TABLE[idx];
        if (!pairs || pairs.length === 0) continue;
        for (const [e1, e2] of pairs) {
          segs.push([edgePoint(e1, x, y), edgePoint(e2, x, y)]);
        }
      }
    }
    logPush(logger, `marchingSquares segs=${segs.length}`);
    if (segs.length < 10) return { contour: null, reason: "contour too short", segs: segs.length };

    const adj = new Map();
    function addEdge(a, b) {
      const ka = keyPt(a), kb = keyPt(b);
      if (!adj.has(ka)) adj.set(ka, []);
      if (!adj.has(kb)) adj.set(kb, []);
      adj.get(ka).push(b);
      adj.get(kb).push(a);
    }
    for (const [a, b] of segs) addEdge(a, b);

    const visited = new Set();
    const loops = [];

    for (const [a, b] of segs) {
      const e1 = keyPt(a) + "->" + keyPt(b);
      const e2 = keyPt(b) + "->" + keyPt(a);
      if (visited.has(e1) || visited.has(e2)) continue;

      const loop = [];
      let curr = a;
      let prev = null;

      for (let guard = 0; guard < 20000; guard++) {
        loop.push(curr);
        const neighbors = adj.get(keyPt(curr)) || [];
        if (neighbors.length === 0) break;

        let next = neighbors[0];
        if (prev && neighbors.length > 1) {
          const kprev = keyPt(prev);
          const cand = neighbors.find(n => keyPt(n) !== kprev);
          if (cand) next = cand;
        }

        visited.add(keyPt(curr) + "->" + keyPt(next));
        prev = curr;
        curr = next;
        if (keyPt(curr) === keyPt(a)) break;
      }

      if (loop.length > 8) loops.push(loop);
    }

    if (!loops.length) return { contour: null, reason: "no loop built", segs: segs.length };
    loops.sort((p, q) => q.length - p.length);
    return { contour: loops[0], reason: "-", segs: segs.length, loops: loops.length };
  }

  function rdpSimplify(points, eps) {
    if (points.length < 6) return points;

    function distToSeg(p, a, b) {
      const x = p[0], y = p[1];
      const x1 = a[0], y1 = a[1];
      const x2 = b[0], y2 = b[1];
      const dx = x2 - x1, dy = y2 - y1;
      if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1);
      const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
      const tt = Math.max(0, Math.min(1, t));
      const px = x1 + tt * dx, py = y1 + tt * dy;
      return Math.hypot(x - px, y - py);
    }

    function rdp(start, end, out) {
      let maxD = 0, idx = -1;
      for (let i = start + 1; i < end; i++) {
        const d = distToSeg(points[i], points[start], points[end]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > eps && idx !== -1) {
        rdp(start, idx, out);
        rdp(idx, end, out);
      } else {
        out.push(points[start]);
      }
    }

    const out = [];
    rdp(0, points.length - 1, out);
    out.push(points[points.length - 1]);
    return out;
  }

  function polygonAreaCentroid(pts) {
    let area = 0, cx = 0, cy = 0;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % n];
      const a = x1 * y2 - x2 * y1;
      area += a;
      cx += (x1 + x2) * a;
      cy += (y1 + y2) * a;
    }
    area *= 0.5;
    if (Math.abs(area) < 1e-6) {
      let sx = 0, sy = 0;
      for (const p of pts) { sx += p[0]; sy += p[1]; }
      return { area: 0, cx: sx / n, cy: sy / n };
    }
    cx /= (6 * area);
    cy /= (6 * area);
    return { area, cx, cy };
  }

  function ensureCCW(pts) {
    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      sum += (b[0] - a[0]) * (b[1] + a[1]);
    }
    if (sum > 0) pts.reverse();
    return pts;
  }

  function computeBBox(bin, w, h) {
    let minX = w, minY = h, maxX = -1, maxY = -1;
    let solid = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = bin[y * w + x];
        solid += v;
        if (!v) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return { ok: false, solid, minX:0, minY:0, maxX:0, maxY:0 };
    return { ok: true, solid, minX, minY, maxX, maxY };
  }

  // Draw src/mask to a downsample canvas based on SRC size (重要: 座標を統一する)
  function makeBinaryFromImages(srcImg, maskImg, opts) {
    const {
      sample = 160,
      alphaThreshold = 16,
      dilateIters = 1,
      invert = false,
      logger = null
    } = opts || {};

    const iw = srcImg.naturalWidth || srcImg.width;
    const ih = srcImg.naturalHeight || srcImg.height;
    if (!iw || !ih) throw new Error("invalid src image size");

    const scale = sample / Math.max(iw, ih);
    const dw = Math.max(16, Math.round(iw * scale));
    const dh = Math.max(16, Math.round(ih * scale));

    const canvas = createCanvas(dw, dh);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, dw, dh);

    // maskがあればそれを、無ければsrcのalphaを使う
    const useImg = maskImg || srcImg;
    ctx.drawImage(useImg, 0, 0, dw, dh);

    const im = ctx.getImageData(0, 0, dw, dh).data;
    const bin = new Uint8Array(dw * dh);
    let solid = 0;
    for (let i = 0, p = 0; p < dw * dh; p++, i += 4) {
      const a = im[i + 3];
      let v = (a >= alphaThreshold) ? 1 : 0;
      if (invert) v = v ? 0 : 1;
      bin[p] = v;
      solid += v;
    }

    if (dilateIters > 0) dilate(bin, dw, dh, dilateIters);

    logPush(logger, `binary(dw=${dw},dh=${dh}) solid=${solid}/${dw*dh}`);

    return { bin, dw, dh, iw, ih };
  }

  ShapeExtract.extract = async function extractShape(options) {
    const opts = options || {};
    const logger = opts.logger || null;
    const timeoutMs = opts.timeoutMs || 12000;

    const srcUrl = opts.srcUrl;
    const maskUrl = opts.maskUrl || null;
    if (!srcUrl) throw new Error("srcUrl is required");

    const meta = {
      version: "dbg-v2-crop",
      srcUrl, maskUrl,
      used: null,
      fallback: false,
      reason: "-",
      vertsCount: 0,
      solidRatio: 0,
      srcW: 0, srcH: 0,
      maskW: 0, maskH: 0,
      cropX: 0, cropY: 0, cropW: 0, cropH: 0,
      spriteOffset: { x: 0.5, y: 0.5 },
      downsample: { w: 0, h: 0 }
    };

    let srcImg = null;
    let maskImg = null;

    try {
      srcImg = await loadImage(srcUrl, timeoutMs);
      meta.srcW = srcImg.naturalWidth || srcImg.width;
      meta.srcH = srcImg.naturalHeight || srcImg.height;

      if (maskUrl) {
        try {
          maskImg = await loadImage(maskUrl, Math.min(timeoutMs, 6000));
          meta.maskW = maskImg.naturalWidth || maskImg.width;
          meta.maskH = maskImg.naturalHeight || maskImg.height;
        } catch (e) {
          logPush(logger, `mask load fail -> use src alpha (${e.message})`);
          maskImg = null;
        }
      }
    } catch (e) {
      meta.fallback = true;
      meta.reason = `texture load fail: ${e.message}`;
      return { ok: false, meta, verts: null, logger, srcImg: null };
    }

    meta.used = maskImg ? "mask" : "src";

    try {
      const binary = makeBinaryFromImages(srcImg, maskImg, {
        sample: opts.sample || 160,
        alphaThreshold: opts.alphaThreshold ?? 16,
        dilateIters: opts.dilateIters ?? 1,
        invert: opts.invert ?? false,
        logger
      });

      meta.downsample.w = binary.dw;
      meta.downsample.h = binary.dh;

      const bb = computeBBox(binary.bin, binary.dw, binary.dh);
      meta.solidRatio = bb.solid / (binary.dw * binary.dh);

      if (!bb.ok || meta.solidRatio < (opts.minSolidRatio ?? 0.02)) {
        meta.fallback = true;
        meta.reason = `too empty solidRatio=${meta.solidRatio.toFixed(3)}`;
        return { ok: true, meta, verts: null, logger, srcImg };
      }

      // bbox in SRC pixel coords
      const sx = binary.iw / binary.dw;
      const sy = binary.ih / binary.dh;

      let x0 = bb.minX * sx;
      let y0 = bb.minY * sy;
      let x1 = (bb.maxX + 1) * sx;
      let y1 = (bb.maxY + 1) * sy;

      // pad bbox (隙間対策＋アンチエイリアス吸収)
      const padRatio = opts.cropPadRatio ?? 0.06; // 6% くらい盛る
      const padMin = opts.cropPadMinPx ?? 2;
      const padMax = opts.cropPadMaxPx ?? 24;
      const pad = Math.max(padMin, Math.min(padMax, Math.round(Math.max(x1 - x0, y1 - y0) * padRatio)));

      x0 = Math.max(0, Math.floor(x0 - pad));
      y0 = Math.max(0, Math.floor(y0 - pad));
      x1 = Math.min(binary.iw, Math.ceil(x1 + pad));
      y1 = Math.min(binary.ih, Math.ceil(y1 + pad));

      const cropW = Math.max(2, x1 - x0);
      const cropH = Math.max(2, y1 - y0);

      meta.cropX = x0; meta.cropY = y0; meta.cropW = cropW; meta.cropH = cropH;

      // contour
      const built = buildContourFromBinary(binary.bin, binary.dw, binary.dh, logger);
      if (!built.contour) {
        meta.fallback = true;
        meta.reason = built.reason || "contour fail";
        return { ok: true, meta, verts: null, logger, srcImg };
      }

      // contour points -> SRC coords -> CROP coords
      let pts = built.contour.map(p => [p[0] * sx - x0, p[1] * sy - y0]);

      // simplify
      const autoEps = Math.max(cropW, cropH) * 0.01;
      const eps = (opts.simplifyEps == null) ? autoEps : opts.simplifyEps;
      pts = rdpSimplify(pts, eps);

      // clamp vertex count
      const maxVerts = opts.maxVerts ?? 64;
      if (pts.length > maxVerts) {
        const step = Math.ceil(pts.length / maxVerts);
        pts = pts.filter((_, i) => i % step === 0);
      }

      if (pts.length < (opts.minVerts ?? 12)) {
        meta.fallback = true;
        meta.reason = `verts too few: ${pts.length}`;
        return { ok: true, meta, verts: null, logger, srcImg };
      }

      pts = ensureCCW(pts);

      // centroid in CROP coords
      const c = polygonAreaCentroid(pts);
      const cx = c.cx, cy = c.cy;

      meta.spriteOffset.x = cx / cropW;
      meta.spriteOffset.y = cy / cropH;

      // center vertices at centroid (so body.position = centroid)
      const verts = pts.map(p => ({ x: p[0] - cx, y: p[1] - cy }));

      meta.vertsCount = verts.length;
      meta.fallback = false;
      meta.reason = "-";

      return { ok: true, meta, verts, logger, srcImg };
    } catch (e) {
      meta.fallback = true;
      meta.reason = `extract exception: ${e.message}`;
      return { ok: true, meta, verts: null, logger, srcImg };
    }
  };

  ShapeExtract.loadImage = loadImage;

  global.ShapeExtract = ShapeExtract;
})(window);

