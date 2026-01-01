/* shape-extract.js (FIXED)
   - Auto-crop to alpha bounding box (important when sprite is tiny in a large canvas)
   - Analyze cropped region at high resolution (analysisMax px) then trace boundary
   - Fallback only when truly impossible
*/
(function () {
  const cache = new Map();
  const DEBUG = { enabled: true, last: null };

  function setDebug(on) { DEBUG.enabled = !!on; }
  function log(...a){ if(DEBUG.enabled) console.log(...a); }
  function warn(...a){ if(DEBUG.enabled) console.warn(...a); }

  function ensureDecomp() {
    try {
      if (window.Matter?.Common?.setDecomp && window.decomp) {
        window.Matter.Common.setDecomp(window.decomp);
      }
    } catch (_) {}
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Image load error: " + src));
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
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function resampleClosed(points, N) {
    if (!points || points.length < 3) return points;

    // remove consecutive duplicates
    const ring = [];
    for (const p of points) {
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

  // simple erosion (removes halo / soft edge), 8-neighbor
  function erode(mask, W, H, iter) {
    let m = mask;
    for (let it = 0; it < iter; it++) {
      const out = new Uint8Array(W * H);
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const i = y * W + x;
          if (!m[i]) continue;
          // if any neighbor is 0 -> erode away
          let ok = 1;
          for (let dy = -1; dy <= 1 && ok; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (!m[(y + dy) * W + (x + dx)]) { ok = 0; break; }
            }
          }
          if (ok) out[i] = 1;
        }
      }
      m = out;
    }
    return m;
  }

  // Moore neighbor tracing boundary (8-connected) on "boundary map"
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

  function buildBoundary(mask, W, H) {
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
    return { boundary, sx, sy };
  }

  async function extract(maskPath, cfg = {}) {
    if (cache.has(maskPath)) return cache.get(maskPath);

    const promise = (async () => {
      const out = { ok:false, reason:"", maskPath };

      try {
        const img = await loadImage(maskPath);
        const iw = img.naturalWidth, ih = img.naturalHeight;
        if (!iw || !ih) { out.reason="natural size is 0"; return out; }

        // ---- cfg normalize ----
        const alphaThreshold = cfg.alphaThreshold ?? cfg.threshold ?? 5;
        const nPoints = cfg.nPoints ?? 180;
        const padPx = cfg.padPx ?? 2;

        // ここが肝：切り出した領域をこのサイズに収めて解析（小さい物体でも輪郭が長くなる）
        const analysisMax = cfg.analysisMax ?? 320; // 256〜512推奨
        const minContour = cfg.minContour ?? 80;

        // 影/ハロー対策（マスクが白シルエットなら 1 でOK）
        const erode1 = cfg.erodePx ?? 1;

        // ---- step1: scan full image once to get bbox + centroid ----
        const base = document.createElement("canvas");
        base.width = iw; base.height = ih;
        const bctx = base.getContext("2d", { willReadFrequently: true });
        bctx.clearRect(0,0,iw,ih);
        bctx.drawImage(img, 0, 0);

        let imgData;
        try {
          imgData = bctx.getImageData(0, 0, iw, ih);
        } catch (e) {
          out.reason = "getImageData failed (tainted canvas?)";
          return out;
        }

        const data = imgData.data;
        let solid = 0, sumX = 0, sumY = 0;
        let minX = iw, minY = ih, maxX = -1, maxY = -1;

        for (let y=0; y<ih; y++) {
          for (let x=0; x<iw; x++) {
            const i = (y*iw + x)*4;
            const a = data[i+3];
            if (a > alphaThreshold) {
              solid++;
              sumX += x; sumY += y;
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
            }
          }
        }

        if (solid < 120) { out.reason="too few solid pixels (mask empty?)"; return out; }

        const solidRatio = solid / (iw * ih);
        const cx0 = sumX / solid;
        const cy0 = sumY / solid;

        // bbox (tight)
        const bboxW = (maxX - minX + 1);
        const bboxH = (maxY - minY + 1);

        // crop with padding
        const cropX = Math.max(0, minX - padPx);
        const cropY = Math.max(0, minY - padPx);
        const cropX2 = Math.min(iw - 1, maxX + padPx);
        const cropY2 = Math.min(ih - 1, maxY + padPx);
        const cropW = cropX2 - cropX + 1;
        const cropH = cropY2 - cropY + 1;

        // ---- step2: draw cropped region to analysis canvas (UPSCALE if small) ----
        const scale = analysisMax / Math.max(cropW, cropH);
        // clamp for sanity (too huge is waste)
        const s = Math.min(6.0, Math.max(0.8, scale)); // small objects get enlarged
        const W = Math.max(64, Math.round(cropW * s));
        const H = Math.max(64, Math.round(cropH * s));
        const inv = 1 / s;

        const ac = document.createElement("canvas");
        ac.width = W; ac.height = H;
        const actx = ac.getContext("2d", { willReadFrequently: true });
        actx.clearRect(0,0,W,H);
        actx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, W, H);

        const aData = actx.getImageData(0,0,W,H).data;
        let mask = new Uint8Array(W * H);
        let aSolid = 0;

        for (let y=0; y<H; y++) {
          for (let x=0; x<W; x++) {
            const i = (y*W + x)*4;
            if (aData[i+3] > alphaThreshold) {
              mask[y*W + x] = 1;
              aSolid++;
            }
          }
        }

        if (aSolid < 160) { out.reason="cropped solid too small"; return out; }

        // attempt A (with erosion)
        const attempts = [
          { erodePx: erode1, bump: 0 },
          { erodePx: 0,      bump: 0 },
          { erodePx: 0,      bump: 1 }, // if still short, we re-render larger once
        ];

        let contour = null;
        let used = null;

        for (const att of attempts) {
          let m = mask;

          if (att.bump === 1) {
            // re-render with larger analysisMax
            const s2 = Math.min(8.0, Math.max(1.0, (analysisMax * 1.6) / Math.max(cropW, cropH)));
            const W2 = Math.max(96, Math.round(cropW * s2));
            const H2 = Math.max(96, Math.round(cropH * s2));
            const inv2 = 1 / s2;

            const ac2 = document.createElement("canvas");
            ac2.width = W2; ac2.height = H2;
            const c2 = ac2.getContext("2d", { willReadFrequently: true });
            c2.clearRect(0,0,W2,H2);
            c2.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, W2, H2);

            const d2 = c2.getImageData(0,0,W2,H2).data;
            const m2 = new Uint8Array(W2*H2);
            for (let y=0; y<H2; y++) for (let x=0; x<W2; x++) {
              const i = (y*W2 + x)*4;
              if (d2[i+3] > alphaThreshold) m2[y*W2 + x] = 1;
            }

            if (att.erodePx > 0) m = erode(m2, W2, H2, att.erodePx);
            const { boundary, sx, sy } = buildBoundary(m, W2, H2);
            if (sx !== -1) {
              const c = traceMoore(boundary, W2, H2, sx, sy);
              if (c && c.length >= minContour) {
                contour = c.map(p => ({
                  // map to original image coords
                  x: (cropX + (p.x * inv2)) - cx0,
                  y: (cropY + (p.y * inv2)) - cy0
                }));
                used = { W:W2, H:H2, inv:inv2, erodePx: att.erodePx, contourLen: c.length, scale: s2 };
                break;
              }
            }
            continue;
          }

          if (att.erodePx > 0) m = erode(mask, W, H, att.erodePx);

          const { boundary, sx, sy } = buildBoundary(m, W, H);
          if (sx === -1) continue;

          const c = traceMoore(boundary, W, H, sx, sy);
          if (c && c.length >= minContour) {
            contour = c.map(p => ({
              x: (cropX + (p.x * inv)) - cx0,
              y: (cropY + (p.y * inv)) - cy0
            }));
            used = { W, H, inv, erodePx: att.erodePx, contourLen: c.length, scale: s };
            break;
          }
        }

        if (!contour) {
          out.reason = "contour too short";
          return out;
        }

        // resample & orientation
        let pts = resampleClosed(contour, nPoints);
        if (!pts || pts.length < 20) { out.reason="resample failed"; return out; }
        if (polygonArea(pts) > 0) pts.reverse(); // clockwise

        out.ok = true;
        out.pts = pts;
        out.iw = iw; out.ih = ih;
        out.bw = bboxW; out.bh = bboxH;
        out.xOffset = Math.max(0, Math.min(1, cx0 / iw));
        out.yOffset = Math.max(0, Math.min(1, cy0 / ih));
        out.solidRatio = solidRatio;
        out._dbg = {
          bboxW, bboxH, cropW, cropH,
          analysisW: used?.W, analysisH: used?.H,
          analysisScale: used?.scale,
          erodePx: used?.erodePx,
          contourLen: used?.contourLen
        };

        DEBUG.last = out;
        return out;

      } catch (e) {
        out.reason = e.message || String(e);
        warn("[ShapeExtract] failed:", out);
        return out;
      }
    })();

    cache.set(maskPath, promise);
    return promise;
  }

  async function makeBody(texturePath, x, y, opt = {}) {
    const Matter = window.Matter;
    if (!Matter) throw new Error("Matter.js not loaded");

    ensureDecomp();

    const maskPath = opt.maskPath ?? texturePath;

    const packed = await extract(maskPath, opt.shapeCfg ?? {});
    const fallback = {
      ok:false,
      reason: packed?.reason || "fallback",
      pts: [
        { x: -60, y: -30 }, { x: 60, y: -30 }, { x: 85, y: 0 },
        { x: 60, y: 30 }, { x: -60, y: 30 }, { x: -85, y: 0 }
      ],
      iw: 200, ih: 120,
      bw: 200, bh: 120,
      xOffset: 0.5, yOffset: 0.5,
      solidRatio: null
    };

    const use = (packed && packed.ok) ? packed : fallback;
    const usedFallback = !(packed && packed.ok);

    if (usedFallback) {
      warn("[ShapeExtract] FALLBACK used:", { maskPath, reason: packed?.reason });
    } else {
      log("[ShapeExtract] OK:", { maskPath, dbg: use._dbg });
    }

    const targetSize = opt.targetSize ?? 150;
    const hitInset = opt.hitInset ?? 0.97;

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
      warn("[ShapeExtract] fromVertices threw:", e);
      body = null;
    }

    if (!body) {
      body = Matter.Bodies.rectangle(x, y, targetSize, targetSize, bodyOpts);
      body.__dbg_forceRect = true;
    }

    // collider scale (tight/loose)
    Matter.Body.scale(body, spriteScale * hitInset, spriteScale * hitInset);

    body.render = body.render || {};
    body.render.sprite = {
      texture: texturePath,
      xScale: spriteScale,
      yScale: spriteScale,
      xOffset: use.xOffset ?? 0.5,
      yOffset: use.yOffset ?? 0.5
    };

    body.__dbg = {
      texturePath,
      maskPath,
      usedFallback,
      reason: usedFallback ? (packed?.reason || "unknown") : "",
      hasDecomp: !!window.decomp,
      vertexCount: body.vertices?.length ?? 0,
      partsCount: body.parts?.length ?? 0,
      spriteScale,
      hitInset,
      xOffset: body.render.sprite.xOffset,
      yOffset: body.render.sprite.yOffset,
      bw: use.bw, bh: use.bh,
      solidRatio: use.solidRatio,
      forcedRect: !!body.__dbg_forceRect,
      dbg: use._dbg || null
    };

    return body;
  }

  window.ShapeExtract = { extract, makeBody, setDebug, _debugLast: () => DEBUG.last };
})();
