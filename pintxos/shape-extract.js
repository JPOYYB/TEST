/* shape-extract.js  (ShapeExtract v10)
 * - Mask PNGの「アルファ(不透明)」から輪郭を抽出してMatter.js用ポリゴンを作る
 * - 失敗したら理由付きでrect fallback
 */
(function () {
  "use strict";

  const ShapeExtract = {};
  ShapeExtract.version = "v10";

  // ===== CONFIG (ここだけ触れば調整できる) =====
  const CONFIG = {
    alphaThreshold: 10,     // マスクの不透明判定（0-255）
    pad: 1,                // bboxの余白（px）
    maxVerts: 64,          // 頂点数上限（多すぎると不安定）
    simplifyEps: 1.6,      // 輪郭簡略化の強さ（大=荒くなる）
    minArea: 30,           // 小さすぎる形状はfallback
    minContour: 30,        // 輪郭点が短すぎるとfallback
  };

  // ---- small utils ----
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`image load failed: ${url}`));
      img.src = url + (url.includes("?") ? "" : `?v=${Date.now()}`); // キャッシュ殺し（デバッグ用）
    });
  }

  function polygonArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  }

  function polygonCentroid(pts) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const cross = p.x * q.y - q.x * p.y;
      a += cross;
      cx += (p.x + q.x) * cross;
      cy += (p.y + q.y) * cross;
    }
    a *= 0.5;
    if (Math.abs(a) < 1e-6) {
      // fallback: average
      let sx = 0, sy = 0;
      for (const p of pts) { sx += p.x; sy += p.y; }
      return { x: sx / pts.length, y: sy / pts.length };
    }
    cx /= (6 * a);
    cy /= (6 * a);
    return { x: cx, y: cy };
  }

  function dist2(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return dx * dx + dy * dy;
  }

  // Ramer–Douglas–Peucker
  function simplifyRDP(points, epsilon) {
    if (points.length <= 3) return points;

    const eps2 = epsilon * epsilon;

    function perpDist2(p, a, b) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (dx === 0 && dy === 0) return dist2(p, a);
      const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
      const tt = clamp(t, 0, 1);
      const x = a.x + tt * dx;
      const y = a.y + tt * dy;
      const ddx = p.x - x, ddy = p.y - y;
      return ddx * ddx + ddy * ddy;
    }

    function rdp(pts) {
      let maxD = 0, idx = -1;
      const a = pts[0];
      const b = pts[pts.length - 1];
      for (let i = 1; i < pts.length - 1; i++) {
        const d = perpDist2(pts[i], a, b);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > eps2 && idx !== -1) {
        const left = rdp(pts.slice(0, idx + 1));
        const right = rdp(pts.slice(idx));
        return left.slice(0, -1).concat(right);
      }
      return [a, b];
    }

    const out = rdp(points);
    // 閉じポリゴンのため、最後が最初と同じなら落とす
    if (out.length >= 2 && dist2(out[0], out[out.length - 1]) < 0.01) out.pop();
    return out;
  }

  // Moore-Neighbor boundary tracing (binary image)
  function traceBoundary(bin, w, h) {
    // start: 上から走査して最初の境界画素
    let sx = -1, sy = -1;
    for (let y = 0; y < h && sy === -1; y++) {
      for (let x = 0; x < w; x++) {
        const v = bin[y * w + x];
        if (!v) continue;
        const up = (y === 0) ? 0 : bin[(y - 1) * w + x];
        if (!up) { sx = x; sy = y; break; }
      }
    }
    if (sx === -1) return null;

    // neighbors (clockwise)
    const N = [
      { dx: -1, dy: -1 }, { dx: 0, dy: -1 }, { dx: 1, dy: -1 },
      { dx: 1, dy: 0 }, { dx: 1, dy: 1 }, { dx: 0, dy: 1 },
      { dx: -1, dy: 1 }, { dx: -1, dy: 0 }
    ];

    let x = sx, y = sy;
    let px = sx - 1, py = sy; // previous point (west)
    const contour = [];
    const maxIter = w * h * 8;

    function idxOfNeighbor(fromX, fromY, toX, toY) {
      const dx = toX - fromX, dy = toY - fromY;
      for (let i = 0; i < 8; i++) if (N[i].dx === dx && N[i].dy === dy) return i;
      return 0;
    }

    const startPrevIndex = idxOfNeighbor(x, y, px, py);
    let prevIndex = startPrevIndex;

    for (let iter = 0; iter < maxIter; iter++) {
      contour.push({ x: x + 0.5, y: y + 0.5 });

      // search neighbors starting from (prevIndex+1) mod 8
      let found = false;
      let nextIndex = (prevIndex + 1) % 8;

      for (let k = 0; k < 8; k++) {
        const ni = (nextIndex + k) % 8;
        const nx = x + N[ni].dx;
        const ny = y + N[ni].dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        if (bin[ny * w + nx]) {
          // move
          px = x; py = y;
          x = nx; y = ny;
          prevIndex = (ni + 5) % 8; // opposite-ish
          found = true;
          break;
        }
      }

      if (!found) break;

      // closed?
      if (x === sx && y === sy && px === (sx - 1) && py === sy) break;
      if (contour.length > 10 && dist2(contour[0], contour[contour.length - 1]) < 0.25) break;
    }

    return contour.length ? contour : null;
  }

  function removeNearDuplicates(pts, minDist = 0.8) {
    if (pts.length <= 3) return pts;
    const out = [pts[0]];
    const md2 = minDist * minDist;
    for (let i = 1; i < pts.length; i++) {
      if (dist2(pts[i], out[out.length - 1]) >= md2) out.push(pts[i]);
    }
    // last vs first
    if (out.length > 3 && dist2(out[0], out[out.length - 1]) < md2) out.pop();
    return out;
  }

  function limitVerts(pts, maxVerts) {
    if (pts.length <= maxVerts) return pts;
    // 等間引き
    const out = [];
    const step = pts.length / maxVerts;
    for (let i = 0; i < maxVerts; i++) out.push(pts[Math.floor(i * step)]);
    return out;
  }

  function extractFromMask(maskImg, opts = {}) {
    const alphaTh = (opts.alphaThreshold ?? CONFIG.alphaThreshold);
    const pad = (opts.pad ?? CONFIG.pad);

    const srcW = maskImg.naturalWidth || maskImg.width;
    const srcH = maskImg.naturalHeight || maskImg.height;

    const c = document.createElement("canvas");
    c.width = srcW; c.height = srcH;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, srcW, srcH);
    ctx.drawImage(maskImg, 0, 0);

    const img = ctx.getImageData(0, 0, srcW, srcH);
    const data = img.data;

    let minX = srcW, minY = srcH, maxX = -1, maxY = -1;
    let solid = 0;

    // bbox
    for (let y = 0; y < srcH; y++) {
      for (let x = 0; x < srcW; x++) {
        const i = (y * srcW + x) * 4;
        const a = data[i + 3];
        if (a > alphaTh) {
          solid++;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (solid === 0 || maxX < minX || maxY < minY) {
      return { ok: false, reason: "mask has no solid pixels" };
    }

    minX = clamp(minX - pad, 0, srcW - 1);
    minY = clamp(minY - pad, 0, srcH - 1);
    maxX = clamp(maxX + pad, 0, srcW - 1);
    maxY = clamp(maxY + pad, 0, srcH - 1);

    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;

    // crop binary
    const bin = new Uint8Array(cropW * cropH);
    let cropSolid = 0;
    for (let y = 0; y < cropH; y++) {
      for (let x = 0; x < cropW; x++) {
        const sx = minX + x, sy = minY + y;
        const i = (sy * srcW + sx) * 4;
        const a = data[i + 3];
        const v = a > alphaTh ? 1 : 0;
        bin[y * cropW + x] = v;
        cropSolid += v;
      }
    }

    const solidRatio = cropSolid / (cropW * cropH);

    // contour
    let contour = traceBoundary(bin, cropW, cropH);
    if (!contour || contour.length < CONFIG.minContour) {
      return {
        ok: false,
        reason: "contour too short",
        meta: { srcW, srcH, minX, minY, cropW, cropH, solidRatio }
      };
    }

    // simplify + cleanup
    contour = removeNearDuplicates(contour, 0.6);
    contour = simplifyRDP(contour, CONFIG.simplifyEps);
    contour = removeNearDuplicates(contour, 0.8);
    contour = limitVerts(contour, CONFIG.maxVerts);

    if (contour.length < 6) {
      return {
        ok: false,
        reason: "too few verts after simplify",
        meta: { srcW, srcH, minX, minY, cropW, cropH, solidRatio }
      };
    }

    // centroid in crop coords
    const area = polygonArea(contour);
    if (Math.abs(area) < CONFIG.minArea) {
      return {
        ok: false,
        reason: "area too small",
        meta: { srcW, srcH, minX, minY, cropW, cropH, solidRatio, area }
      };
    }

    // Matterは時計回りが扱いやすい（逆なら反転）
    let pts = contour.slice();
    if (area > 0) pts.reverse();

    const centroid = polygonCentroid(pts);
    // center around centroid: verts are in "crop pixel space", centered
    const verts = pts.map(p => ({ x: p.x - centroid.x, y: p.y - centroid.y }));

    // sprite anchor offset (texture coords): crop中心をbody中心に合わせたい
    const cropCenterX = (minX + cropW / 2) / srcW;
    const cropCenterY = (minY + cropH / 2) / srcH;

    return {
      ok: true,
      verts,
      parts: 1,
      solidRatio,
      bbox: { x: minX, y: minY, w: cropW, h: cropH },
      crop: { w: cropW, h: cropH },
      offset: { x: cropCenterX, y: cropCenterY },
      meta: { srcW, srcH, minX, minY, cropW, cropH }
    };
  }

  // Public API
  ShapeExtract.preload = async function ({
    count,
    texPattern = "img/{i}.png",
    maskPattern = "mask/{i}.png",
    log = () => {}
  }) {
    const assets = [];
    for (let i = 1; i <= count; i++) {
      const texUrl = texPattern.replace("{i}", i);
      const maskUrl = maskPattern.replace("{i}", i);
      const [texImg, maskImg] = await Promise.all([loadImage(texUrl), loadImage(maskUrl)]);
      const shape = extractFromMask(maskImg);
      assets.push({ i, texUrl, maskUrl, texImg, maskImg, shape });
      assets[i - 1] = assets[assets.length - 1];
      log({ i, texUrl, maskUrl, shape });
    }
    return assets;
  };

  ShapeExtract.extractFromMask = extractFromMask;

  window.ShapeExtract = ShapeExtract;
})();
