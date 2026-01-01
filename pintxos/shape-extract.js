/* shape-extract.js
 * Debug-first contour extraction for Matter.js Bodies.fromVertices
 * - Loads mask or texture, extracts boundary by marching squares
 * - Returns verts centered at centroid + sprite offsets
 * - Never hangs: has timeouts, returns structured debug meta
 */
(function (global) {
  "use strict";

  const ShapeExtract = {};

  function nowMs() { return (performance && performance.now) ? performance.now() : Date.now(); }

  function logPush(logger, msg) {
    if (!logger) return;
    logger.push({ t: nowMs(), msg });
  }

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

  function getBinaryFromImage(img, opts) {
    const {
      sample = 160,             // downsample size (max dimension)
      alphaThreshold = 16,      // 0-255 (use alpha channel)
      dilateIters = 1,          // inflate silhouette
      invert = false,           // if mask is inverted
      logger = null
    } = opts || {};

    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) throw new Error("invalid image size");

    const scale = sample / Math.max(iw, ih);
    const dw = Math.max(16, Math.round(iw * scale));
    const dh = Math.max(16, Math.round(ih * scale));

    const canvas = createCanvas(dw, dh);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, dw, dh);
    ctx.drawImage(img, 0, 0, dw, dh);

    const im = ctx.getImageData(0, 0, dw, dh).data;

    // binary grid at pixel centers: 1=solid, 0=empty
    const bin = new Uint8Array(dw * dh);
    let solid = 0;
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const i = (y * dw + x) * 4;
        const a = im[i + 3]; // alpha
        let v = (a >= alphaThreshold) ? 1 : 0;
        if (invert) v = v ? 0 : 1;
        bin[y * dw + x] = v;
        solid += v;
      }
    }

    // optional dilate to reduce "gap" caused by thin masks / antialias
    if (dilateIters > 0) {
      dilate(bin, dw, dh, dilateIters);
    }

    logPush(logger, `binary dw=${dw} dh=${dh} solid=${solid}/${dw * dh}`);

    return { bin, dw, dh, iw, ih };
  }

  function dilate(bin, w, h, iters) {
    // 8-neighborhood dilation
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

  // Marching squares segments table (corners: tl=1,tr=2,br=4,bl=8)
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
    // cell at (x,y), size 1
    switch (edge) {
      case "left": return [x, y + 0.5];
      case "right": return [x + 1, y + 0.5];
      case "top": return [x + 0.5, y];
      case "bottom": return [x + 0.5, y + 1];
      default: return [x + 0.5, y + 0.5];
    }
  }

  function keyPt(p) {
    // stable hash
    return `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
  }

  function buildContourFromBinary(bin, w, h, logger) {
    const segs = [];

    // iterate cells (w-1 x h-1)
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
          const p1 = edgePoint(e1, x, y);
          const p2 = edgePoint(e2, x, y);
          segs.push([p1, p2]);
        }
      }
    }

    logPush(logger, `marchingSquares segs=${segs.length}`);

    if (segs.length < 10) {
      return { contour: null, reason: "contour too short", segs: segs.length };
    }

    // chain segments into loops
    const adj = new Map(); // pointKey -> array of neighbor point arrays
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
      const ekey = keyPt(a) + "->" + keyPt(b);
      const ekey2 = keyPt(b) + "->" + keyPt(a);
      if (visited.has(ekey) || visited.has(ekey2)) continue;

      // start a walk
      const loop = [];
      let curr = a;
      let prev = null;

      for (let guard = 0; guard < 20000; guard++) {
        loop.push(curr);
        const neighbors = adj.get(keyPt(curr)) || [];
        if (neighbors.length === 0) break;

        // pick next that is not prev if possible
        let next = neighbors[0];
        if (prev && neighbors.length > 1) {
          const kprev = keyPt(prev);
          const cand = neighbors.find(n => keyPt(n) !== kprev);
          if (cand) next = cand;
        }

        // mark edge visited
        visited.add(keyPt(curr) + "->" + keyPt(next));
        prev = curr;
        curr = next;

        // closed?
        if (keyPt(curr) === keyPt(a)) break;
      }

      if (loop.length > 8) loops.push(loop);
    }

    if (loops.length === 0) {
      return { contour: null, reason: "no loop built", segs: segs.length };
    }

    // choose largest loop by length
    loops.sort((p, q) => q.length - p.length);
    const contour = loops[0];

    return { contour, reason: "-", segs: segs.length, loops: loops.length };
  }

  function rdpSimplify(points, eps) {
    if (points.length < 6) return points;

    // distance from point to segment
    function distToSeg(p, a, b) {
      const x = p[0], y = p[1];
      const x1 = a[0], y1 = a[1];
      const x2 = b[0], y2 = b[1];
      const dx = x2 - x1, dy = y2 - y1;
      if (dx === 0 && dy === 0) {
        const ddx = x - x1, ddy = y - y1;
        return Math.hypot(ddx, ddy);
      }
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
    // pts: [ [x,y], ... ] (closed or open)
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
      // fallback: average
      let sx = 0, sy = 0;
      for (const p of pts) { sx += p[0]; sy += p[1]; }
      return { area: 0, cx: sx / n, cy: sy / n };
    }
    cx /= (6 * area);
    cy /= (6 * area);
    return { area, cx, cy };
  }

  function ensureCCW(pts) {
    // Matter likes clockwise? Actually both are ok; keep CCW stable
    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      sum += (b[0] - a[0]) * (b[1] + a[1]);
    }
    // sum > 0 => clockwise in this formula
    if (sum > 0) pts.reverse();
    return pts;
  }

  ShapeExtract.extract = async function extractShape(options) {
    const opts = options || {};
    const logger = opts.logger || null;
    const timeoutMs = opts.timeoutMs || 12000;

    const srcUrl = opts.srcUrl;
    if (!srcUrl) throw new Error("srcUrl is required");

    const maskUrl = opts.maskUrl || null;

    const meta = {
      version: "dbg-v1",
      srcUrl,
      maskUrl,
      used: null,            // "mask" | "src"
      fallback: false,
      reason: "-",
      vertsCount: 0,
      parts: 1,
      solidRatio: 0,
      spriteOffset: { x: 0.5, y: 0.5 },
      bbox: { w: 0, h: 0 },
      downsample: { w: 0, h: 0 }
    };

    logPush(logger, `extract start src=${srcUrl} mask=${maskUrl}`);

    let srcImg = null;
    let maskImg = null;

    try {
      // Load texture always
      srcImg = await loadImage(srcUrl, timeoutMs);
      // Try load mask, but don't hang if missing
      if (maskUrl) {
        try {
          maskImg = await loadImage(maskUrl, Math.min(timeoutMs, 6000));
        } catch (e) {
          logPush(logger, `mask load failed -> use src alpha: ${e.message}`);
          maskImg = null;
        }
      }
    } catch (e) {
      meta.fallback = true;
      meta.reason = `texture load fail: ${e.message}`;
      return { ok: false, meta, verts: null, logger };
    }

    const imgForBinary = (maskImg || srcImg);
    meta.used = maskImg ? "mask" : "src";

    try {
      const binary = getBinaryFromImage(imgForBinary, {
        sample: opts.sample || 160,
        alphaThreshold: opts.alphaThreshold ?? 16,
        dilateIters: opts.dilateIters ?? 1,
        invert: opts.invert ?? false,
        logger
      });

      meta.downsample.w = binary.dw;
      meta.downsample.h = binary.dh;

      meta.bbox.w = binary.iw;
      meta.bbox.h = binary.ih;

      // solid ratio
      let solid = 0;
      for (let i = 0; i < binary.bin.length; i++) solid += binary.bin[i];
      meta.solidRatio = solid / binary.bin.length;

      // If almost empty -> fallback
      if (meta.solidRatio < (opts.minSolidRatio ?? 0.02)) {
        meta.fallback = true;
        meta.reason = `too empty solidRatio=${meta.solidRatio.toFixed(3)}`;
        return { ok: true, meta, verts: null, logger, srcImg };
      }

      const built = buildContourFromBinary(binary.bin, binary.dw, binary.dh, logger);
      if (!built.contour) {
        meta.fallback = true;
        meta.reason = built.reason || "contour fail";
        return { ok: true, meta, verts: null, logger, srcImg };
      }

      // Convert contour points (grid coords) -> image pixel coords
      const sx = binary.iw / binary.dw;
      const sy = binary.ih / binary.dh;
      let pts = built.contour.map(p => [p[0] * sx, p[1] * sy]);

      // Simplify
      const eps = opts.simplifyEps ?? Math.max(binary.iw, binary.ih) * 0.01;
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

      // centroid in image coords
      const c = polygonAreaCentroid(pts);
      const cx = c.cx, cy = c.cy;

      meta.spriteOffset.x = cx / binary.iw;
      meta.spriteOffset.y = cy / binary.ih;

      // Center vertices around centroid -> body center at centroid
      let verts = pts.map(p => ({ x: p[0] - cx, y: p[1] - cy }));

      meta.vertsCount = verts.length;
      meta.reason = "-";
      meta.fallback = false;

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
