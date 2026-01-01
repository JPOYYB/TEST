/* shape-extract.js  (ShapeExtract v11)
 * Fixes:
 * - sprite offset uses CONTOUR CENTROID (not bbox center) => polygon aligns with sprite
 * - choose largest connected component (avoid picking tiny garnish/toothpick first)
 * - optional dilation to preserve thin structures (morphDilate)
 */
(function () {
  "use strict";

  const ShapeExtract = {};
  ShapeExtract.version = "v11";

  // ===== CONFIG =====
  const CONFIG = {
    alphaThreshold: 2,     // 透明/不透明の境界（低めでOK）
    pad: 1,               // bbox余白(px)
    morphDilate: 1,       // 0=なし / 1〜2で細部を太らせる（繊細構造に効く）
    maxVerts: 96,         // 細部を拾うため少し増やす（増やしすぎると不安定）
    simplifyEps: 1.1,     // 小さいほど形に沿う（小さすぎるとギザる）
    minArea: 40,
    minContour: 35
  };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`image load failed: ${url}`));
      img.src = url + (url.includes("?") ? "" : `?v=${Date.now()}`);
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

  // RDP simplify
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
      const a = pts[0], b = pts[pts.length - 1];
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
    if (out.length >= 2 && dist2(out[0], out[out.length - 1]) < 0.01) out.pop();
    return out;
  }

  function removeNearDuplicates(pts, minDist = 0.8) {
    if (pts.length <= 3) return pts;
    const out = [pts[0]];
    const md2 = minDist * minDist;
    for (let i = 1; i < pts.length; i++) {
      if (dist2(pts[i], out[out.length - 1]) >= md2) out.push(pts[i]);
    }
    if (out.length > 3 && dist2(out[0], out[out.length - 1]) < md2) out.pop();
    return out;
  }

  function limitVerts(pts, maxVerts) {
    if (pts.length <= maxVerts) return pts;
    const out = [];
    const step = pts.length / maxVerts;
    for (let i = 0; i < maxVerts; i++) out.push(pts[Math.floor(i * step)]);
    return out;
  }

  // 8-neighbor dilation (radius 1 or 2)
  function dilate(bin, w, h, r) {
    if (!r || r <= 0) return bin;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!bin[y * w + x]) continue;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            out[ny * w + nx] = 1;
          }
        }
      }
    }
    // union (元のbinも残す)
    for (let i = 0; i < out.length; i++) if (bin[i]) out[i] = 1;
    return out;
  }

  // Connected components: pick largest (by pixel count)
  function pickLargestComponent(bin, w, h) {
    const vis = new Uint8Array(w * h);
    let best = null;
    let compCount = 0;

    const qx = new Int32Array(w * h);
    const qy = new Int32Array(w * h);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (!bin[idx] || vis[idx]) continue;

        compCount++;
        let head = 0, tail = 0;
        qx[tail] = x; qy[tail] = y; tail++;
        vis[idx] = 1;

        let cnt = 0;
        let minX = x, minY = y, maxX = x, maxY = y;

        while (head < tail) {
          const cx = qx[head], cy = qy[head]; head++;
          cnt++;

          if (cx < minX) minX = cx;
          if (cy < minY) minY = cy;
          if (cx > maxX) maxX = cx;
          if (cy > maxY) maxY = cy;

          // 4-neighborでOK（細い連結が切れにくい）
          const nb = [
            [cx - 1, cy], [cx + 1, cy],
            [cx, cy - 1], [cx, cy + 1],
          ];
          for (const [nx, ny] of nb) {
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const ni = ny * w + nx;
            if (!bin[ni] || vis[ni]) continue;
            vis[ni] = 1;
            qx[tail] = nx; qy[tail] = ny; tail++;
          }
        }

        if (!best || cnt > best.count) {
          best = { count: cnt, minX, minY, maxX, maxY };
        }
      }
    }

    if (!best) return { ok: false, compCount: 0 };

    const bw = best.maxX - best.minX + 1;
    const bh = best.maxY - best.minY + 1;
    const out = new Uint8Array(bw * bh);

    for (let y = best.minY; y <= best.maxY; y++) {
      for (let x = best.minX; x <= best.maxX; x++) {
        const v = bin[y * w + x];
        if (!v) continue;
        out[(y - best.minY) * bw + (x - best.minX)] = 1;
      }
    }

    return {
      ok: true,
      compCount,
      bin: out,
      w: bw,
      h: bh,
      bbox: { x: best.minX, y: best.minY, w: bw, h: bh },
      count: best.count
    };
  }

  // Boundary tracing (Moore-like)
  function traceBoundary(bin, w, h) {
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

    const N = [
      { dx: -1, dy: -1 }, { dx: 0, dy: -1 }, { dx: 1, dy: -1 },
      { dx: 1, dy: 0 }, { dx: 1, dy: 1 }, { dx: 0, dy: 1 },
      { dx: -1, dy: 1 }, { dx: -1, dy: 0 }
    ];

    let x = sx, y = sy;
    let px = sx - 1, py = sy;
    const contour = [];
    const maxIter = w * h * 8;

    function idxOfNeighbor(fromX, fromY, toX, toY) {
      const dx = toX - fromX, dy = toY - fromY;
      for (let i = 0; i < 8; i++) if (N[i].dx === dx && N[i].dy === dy) return i;
      return 0;
    }

    let prevIndex = idxOfNeighbor(x, y, px, py);

    for (let iter = 0; iter < maxIter; iter++) {
      contour.push({ x: x + 0.5, y: y + 0.5 });

      let found = false;
      const start = (prevIndex + 1) % 8;
      for (let k = 0; k < 8; k++) {
        const ni = (start + k) % 8;
        const nx = x + N[ni].dx;
        const ny = y + N[ni].dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        if (bin[ny * w + nx]) {
          px = x; py = y;
          x = nx; y = ny;
          prevIndex = (ni + 5) % 8;
          found = true;
          break;
        }
      }
      if (!found) break;
      if (x === sx && y === sy && px === (sx - 1) && py === sy) break;
      if (contour.length > 12 && dist2(contour[0], contour[contour.length - 1]) < 0.25) break;
    }
    return contour.length ? contour : null;
  }

  function extractFromMask(maskImg, opts = {}) {
    const alphaTh = (opts.alphaThreshold ?? CONFIG.alphaThreshold);
    const pad = (opts.pad ?? CONFIG.pad);
    const dil = (opts.morphDilate ?? CONFIG.morphDilate);

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

    const cropW0 = maxX - minX + 1;
    const cropH0 = maxY - minY + 1;

    let bin0 = new Uint8Array(cropW0 * cropH0);
    let cropSolid0 = 0;
    for (let y = 0; y < cropH0; y++) {
      for (let x = 0; x < cropW0; x++) {
        const sx = minX + x, sy = minY + y;
        const i = (sy * srcW + sx) * 4;
        const a = data[i + 3];
        const v = a > alphaTh ? 1 : 0;
        bin0[y * cropW0 + x] = v;
        cropSolid0 += v;
      }
    }

    // thicken a bit (helps thin structures and closes tiny gaps)
    bin0 = dilate(bin0, cropW0, cropH0, dil);

    // pick largest component (avoid tiny garnish picked first)
    const picked = pickLargestComponent(bin0, cropW0, cropH0);
    if (!picked.ok) {
      return { ok: false, reason: "no component after bin", meta: { srcW, srcH } };
    }

    const bin = picked.bin;
    const cropW = picked.w;
    const cropH = picked.h;

    // refine crop origin (absolute in src)
    const compMinX = picked.bbox.x;
    const compMinY = picked.bbox.y;
    const absMinX = minX + compMinX;
    const absMinY = minY + compMinY;

    let cropSolid = 0;
    for (let i = 0; i < bin.length; i++) cropSolid += bin[i];
    const solidRatio = cropSolid / (cropW * cropH);

    // contour
    let contour = traceBoundary(bin, cropW, cropH);
    if (!contour || contour.length < CONFIG.minContour) {
      return {
        ok: false,
        reason: "contour too short",
        meta: { srcW, srcH, absMinX, absMinY, cropW, cropH, solidRatio, compCount: picked.compCount }
      };
    }

    contour = removeNearDuplicates(contour, 0.6);
    contour = simplifyRDP(contour, CONFIG.simplifyEps);
    contour = removeNearDuplicates(contour, 0.8);
    contour = limitVerts(contour, CONFIG.maxVerts);

    if (contour.length < 6) {
      return {
        ok: false,
        reason: "too few verts after simplify",
        meta: { srcW, srcH, absMinX, absMinY, cropW, cropH, solidRatio, compCount: picked.compCount }
      };
    }

    const area = polygonArea(contour);
    if (Math.abs(area) < CONFIG.minArea) {
      return {
        ok: false,
        reason: "area too small",
        meta: { srcW, srcH, absMinX, absMinY, cropW, cropH, solidRatio, area, compCount: picked.compCount }
      };
    }

    let pts = contour.slice();
    if (area > 0) pts.reverse();

    const centroid = polygonCentroid(pts);
    const verts = pts.map(p => ({ x: p.x - centroid.x, y: p.y - centroid.y }));

    // IMPORTANT: sprite offset should match the SAME point as body center (= centroid in src coords)
    const centroidAbsX = absMinX + centroid.x;
    const centroidAbsY = absMinY + centroid.y;

    return {
      ok: true,
      verts,
      parts: 1,
      solidRatio,
      crop: { w: cropW, h: cropH },
      bbox: { x: absMinX, y: absMinY, w: cropW, h: cropH },
      offset: { x: centroidAbsX / srcW, y: centroidAbsY / srcH }, // ←これがズレ解消の核心
      meta: {
        version: ShapeExtract.version,
        srcW, srcH,
        absMinX, absMinY, cropW, cropH,
        centroidAbsX, centroidAbsY,
        compCount: picked.compCount,
        pickedPixels: picked.count,
        dilate: dil
      }
    };
  }

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
      log({ i, texUrl, maskUrl, shape });
    }
    return assets;
  };

  ShapeExtract.extractFromMask = extractFromMask;
  window.ShapeExtract = ShapeExtract;
})();
