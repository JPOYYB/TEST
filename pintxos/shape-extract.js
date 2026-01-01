/* shape-extract.js  (Matter.js 読み込み後に使う) */
(() => {
  const VERSION = "v10-mask-centroid-crop";

  // ===== Utils =====
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous"; // GitHub Pages想定
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Image load failed: " + url));
      img.src = url;
    });
  }

  function drawToCanvas(img) {
    const c = document.createElement("canvas");
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0);
    return { c, ctx };
  }

  function alphaBBox(imgData, w, h, thr) {
    let minX = w, minY = h, maxX = -1, maxY = -1;
    let solid = 0;
    const data = imgData.data;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        const a = data[row + x * 4 + 3];
        if (a > thr) {
          solid++;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    // 端を少し余裕持つ（輪郭欠け防止）
    const pad = 1;
    minX = clamp(minX - pad, 0, w - 1);
    minY = clamp(minY - pad, 0, h - 1);
    maxX = clamp(maxX + pad, 0, w - 1);
    maxY = clamp(maxY + pad, 0, h - 1);

    return {
      x: minX,
      y: minY,
      w: (maxX - minX + 1),
      h: (maxY - minY + 1),
      solid
    };
  }

  function cropCanvas(srcCanvas, bbox) {
    const c = document.createElement("canvas");
    c.width = bbox.w;
    c.height = bbox.h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(srcCanvas, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, bbox.w, bbox.h);
    return { c, ctx };
  }

  // ===== Marching Squares (binary mask) => segments => loops =====
  // point key as integer grid (x2,y2) to avoid float keys
  function pKey(x2, y2) { return x2 + "," + y2; }
  function pVal(key) {
    const [x2, y2] = key.split(",").map(Number);
    return { x: x2 / 2, y: y2 / 2 };
  }

  function marchingSquaresLoops(alpha, w, h, thr) {
    // alpha: Uint8ClampedArray RGBA, but we only use A
    const A = alpha;
    const idxA = (x, y) => (y * w + x) * 4 + 3;

    const isSolid = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return false;
      return A[idxA(x, y)] > thr;
    };
    const centerSolid = (x, y) => {
      // sample near center pixel
      const cx = clamp(Math.floor(x), 0, w - 1);
      const cy = clamp(Math.floor(y), 0, h - 1);
      return A[idxA(cx, cy)] > thr;
    };

    const adj = new Map(); // key -> Set(nei)
    const addEdge = (k1, k2) => {
      if (!adj.has(k1)) adj.set(k1, new Set());
      if (!adj.has(k2)) adj.set(k2, new Set());
      adj.get(k1).add(k2);
      adj.get(k2).add(k1);
    };

    // cell loop
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        const a = isSolid(x, y) ? 1 : 0;
        const b = isSolid(x + 1, y) ? 1 : 0;
        const c = isSolid(x + 1, y + 1) ? 1 : 0;
        const d = isSolid(x, y + 1) ? 1 : 0;
        const code = (a) | (b << 1) | (c << 2) | (d << 3);
        if (code === 0 || code === 15) continue;

        // points as x2,y2
        const L = { x2: 2 * x,     y2: 2 * y + 1 };
        const T = { x2: 2 * x + 1, y2: 2 * y     };
        const R = { x2: 2 * x + 2, y2: 2 * y + 1 };
        const B = { x2: 2 * x + 1, y2: 2 * y + 2 };

        const kL = pKey(L.x2, L.y2);
        const kT = pKey(T.x2, T.y2);
        const kR = pKey(R.x2, R.y2);
        const kB = pKey(B.x2, B.y2);

        // disambiguation for 5 / 10 using center
        const cen = centerSolid(x + 0.5, y + 0.5);

        switch (code) {
          case 1:  addEdge(kL, kT); break;
          case 2:  addEdge(kT, kR); break;
          case 3:  addEdge(kL, kR); break;
          case 4:  addEdge(kR, kB); break;
          case 6:  addEdge(kT, kB); break;
          case 7:  addEdge(kL, kB); break;
          case 8:  addEdge(kB, kL); break;
          case 9:  addEdge(kT, kB); break;
          case 11: addEdge(kR, kB); break;
          case 12: addEdge(kR, kL); break;
          case 13: addEdge(kT, kR); break;
          case 14: addEdge(kL, kT); break;

          case 5:
            // a & c solid
            if (cen) { addEdge(kL, kT); addEdge(kR, kB); }
            else     { addEdge(kT, kR); addEdge(kL, kB); }
            break;

          case 10:
            // b & d solid
            if (cen) { addEdge(kT, kR); addEdge(kL, kB); }
            else     { addEdge(kL, kT); addEdge(kR, kB); }
            break;

          default:
            // other cases are covered above
            break;
        }
      }
    }

    // build loops from adjacency (degree should be 2 on contours)
    const visitedEdge = new Set();
    const loops = [];

    const edgeKey = (a, b) => (a < b ? (a + "|" + b) : (b + "|" + a));

    for (const [start, neis] of adj.entries()) {
      for (const n of neis) {
        const ek = edgeKey(start, n);
        if (visitedEdge.has(ek)) continue;

        // trace polyline
        let curr = start;
        let prev = null;
        const poly = [pVal(curr)];

        while (true) {
          const neighbors = Array.from(adj.get(curr) || []);
          let next = null;

          if (prev === null) {
            next = neighbors[0];
          } else {
            next = neighbors.find(k => k !== prev) || null;
          }

          if (!next) break;

          visitedEdge.add(edgeKey(curr, next));
          prev = curr;
          curr = next;
          poly.push(pVal(curr));

          // close if back to start
          if (curr === start) break;

          // safety
          if (poly.length > 5000) break;
        }

        if (poly.length >= 10 && curr === start) {
          // remove last dup start
          poly.pop();
          loops.push(poly);
        }
      }
    }

    return loops;
  }

  function polygonArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  }

  function polygonCentroid(pts) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      const cross = p.x * q.y - q.x * p.y;
      a += cross;
      cx += (p.x + q.x) * cross;
      cy += (p.y + q.y) * cross;
    }
    a *= 0.5;
    if (Math.abs(a) < 1e-6) {
      // fallback: average
      const n = pts.length;
      const sx = pts.reduce((s, p) => s + p.x, 0);
      const sy = pts.reduce((s, p) => s + p.y, 0);
      return { x: sx / n, y: sy / n };
    }
    cx /= (6 * a);
    cy /= (6 * a);
    return { x: cx, y: cy };
  }

  // Ramer–Douglas–Peucker for closed polygon (run on open then close)
  function rdp(points, epsilon) {
    if (points.length < 3) return points;

    const sq = (v) => v * v;
    const dist2PointToSeg = (p, a, b) => {
      const vx = b.x - a.x, vy = b.y - a.y;
      const wx = p.x - a.x, wy = p.y - a.y;
      const c1 = vx * wx + vy * wy;
      if (c1 <= 0) return sq(p.x - a.x) + sq(p.y - a.y);
      const c2 = vx * vx + vy * vy;
      if (c2 <= c1) return sq(p.x - b.x) + sq(p.y - b.y);
      const t = c1 / c2;
      const px = a.x + t * vx, py = a.y + t * vy;
      return sq(p.x - px) + sq(p.y - py);
    };

    function simplify(pts) {
      if (pts.length < 3) return pts;
      let maxD = 0, idx = 0;
      const a = pts[0], b = pts[pts.length - 1];
      for (let i = 1; i < pts.length - 1; i++) {
        const d = dist2PointToSeg(pts[i], a, b);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > epsilon * epsilon) {
        const left = simplify(pts.slice(0, idx + 1));
        const right = simplify(pts.slice(idx));
        return left.slice(0, -1).concat(right);
      }
      return [a, b];
    }

    return simplify(points);
  }

  // convex hull (monotonic chain) fallback
  function convexHull(points) {
    if (points.length < 3) return points;

    const pts = points.slice().sort((p, q) => (p.x === q.x ? p.y - q.y : p.x - q.x));
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  function sampleSolidPoints(alpha, w, h, thr, step) {
    const pts = [];
    const idxA = (x, y) => (y * w + x) * 4 + 3;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        if (alpha[idxA(x, y)] > thr) pts.push({ x, y });
      }
    }
    return pts;
  }

  // ===== Main: prepare asset =====
  const cache = new Map();

  async function prepare({ textureUrl, maskUrl, targetMax = 140, alphaThr = 10, hitInset = 0.97, maxVerts = 72, debug = false }) {
    const key = `${textureUrl}||${maskUrl}||${targetMax}||${alphaThr}||${hitInset}`;
    if (cache.has(key)) return cache.get(key);

    const [texImg, maskImg] = await Promise.all([loadImage(textureUrl), loadImage(maskUrl)]);
    const { c: texC } = drawToCanvas(texImg);
    const { c: maskC, ctx: maskCtx } = drawToCanvas(maskImg);

    const w0 = maskC.width, h0 = maskC.height;
    const maskData = maskCtx.getImageData(0, 0, w0, h0);
    const bbox = alphaBBox(maskData, w0, h0, alphaThr);
    if (!bbox) throw new Error(`Mask has no solid pixels: ${maskUrl}`);

    const { c: maskCropC, ctx: maskCropCtx } = cropCanvas(maskC, bbox);
    const maskCropData = maskCropCtx.getImageData(0, 0, bbox.w, bbox.h);

    // outer contour loops
    let loops = marchingSquaresLoops(maskCropData.data, bbox.w, bbox.h, alphaThr);

    // choose largest area loop
    let poly = null;
    if (loops.length > 0) {
      loops.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
      poly = loops[0];
    }

    // simplify contour
    const maxDim = Math.max(bbox.w, bbox.h);
    const eps = clamp(maxDim * 0.01, 0.8, 2.0); // だいたい1px前後
    if (poly && poly.length > 8) {
      // close -> simplify as open -> reclose
      const open = poly.concat([poly[0]]);
      const simp = rdp(open, eps);
      simp.pop();
      poly = simp;
    }

    // fallback to hull if contour unstable
    let fallback = false;
    let reason = "";
    if (!poly || poly.length < 8) {
      const step = clamp(Math.floor(maxDim / 90) + 1, 1, 4);
      const pts = sampleSolidPoints(maskCropData.data, bbox.w, bbox.h, alphaThr, step);
      const hull = convexHull(pts);
      if (hull && hull.length >= 3) {
        poly = hull;
        fallback = true;
        reason = "used hull fallback";
      } else {
        // last fallback: bbox rect (なるべく避けたいが保険)
        poly = [
          { x: 0, y: 0 },
          { x: bbox.w, y: 0 },
          { x: bbox.w, y: bbox.h },
          { x: 0, y: bbox.h }
        ];
        fallback = true;
        reason = "used rect fallback";
      }
    }

    // ensure consistent winding (Matterはどちらでも処理するが安定のため)
    const area = polygonArea(poly);
    if (area > 0) poly.reverse(); // clockwise

    // centroid in crop coords
    const cen = polygonCentroid(poly);

    // translate to centroid-based local coords
    let verts = poly.map(p => ({ x: p.x - cen.x, y: p.y - cen.y }));

    // scale to targetMax (pixels == world units)
    const scale = targetMax / Math.max(bbox.w, bbox.h);
    verts = verts.map(v => ({ x: v.x * scale * hitInset, y: v.y * scale * hitInset }));

    // limit vertices
    if (verts.length > maxVerts) {
      // re-simplify stronger if too many
      const back = poly.concat([poly[0]]);
      const stronger = rdp(back, eps * 2.0);
      stronger.pop();
      const c2 = polygonCentroid(stronger);
      let vv = stronger.map(p => ({ x: (p.x - c2.x) * scale * hitInset, y: (p.y - c2.y) * scale * hitInset }));
      if (vv.length >= 8) verts = vv;
    }

    // crop texture exactly same bbox (mask-based)
    const { c: texCropC, ctx: texCropCtx } = cropCanvas(texC, bbox);
    const texDataUrl = texCropC.toDataURL("image/png");

    // sprite offsets: body position should correspond to centroid location within cropped texture
    const xOffset = clamp(cen.x / bbox.w, 0, 1);
    const yOffset = clamp(cen.y / bbox.h, 0, 1);

    const solidRatio = bbox.solid / (bbox.w * bbox.h);

    const asset = {
      version: VERSION,
      textureUrl,
      maskUrl,
      textureDataUrl: texDataUrl,
      cropW: bbox.w,
      cropH: bbox.h,
      bboxX: bbox.x,
      bboxY: bbox.y,
      centroidX: cen.x,
      centroidY: cen.y,
      spriteScale: scale,
      spriteOffsetX: xOffset,
      spriteOffsetY: yOffset,
      verts,
      fallback,
      reason,
      solidRatio,
      meta: { targetMax, alphaThr, hitInset, eps }
    };

    if (debug) console.log("ShapeExtract asset", asset);

    cache.set(key, asset);
    return asset;
  }

  function createBody(asset, x, y, opts = {}) {
    const Bodies = Matter.Bodies;
    const Body = Matter.Body;

    const base = {
      label: "Pintxo",
      friction: 0.9,
      frictionStatic: 1.0,
      restitution: 0.02,
      density: 0.0018,
      slop: 0.01, // ここが地味に効く（接触の“遊び”を減らす）
      render: {
        sprite: {
          texture: asset.textureDataUrl,
          xScale: asset.spriteScale,
          yScale: asset.spriteScale,
          xOffset: asset.spriteOffsetX,
          yOffset: asset.spriteOffsetY
        }
      }
    };

    const body = Bodies.fromVertices(x, y, [asset.verts], { ...base, ...opts }, true);

    // compound のとき sprite を1回だけ描画する（パーツ描画を消す）
    if (body && body.parts && body.parts.length > 1) {
      for (let i = 1; i < body.parts.length; i++) {
        body.parts[i].render.visible = false;
      }
    }

    // 念のため
    if (body) Body.setPosition(body, { x, y });

    return body;
  }

  window.ShapeExtract = {
    version: VERSION,
    prepare,
    createBody
  };
})();
