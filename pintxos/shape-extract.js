/* shape-extract.js
 * Mask PNG (alpha) -> polygon vertices centered at polygon centroid.
 * Returns:
 *  { ok, reason, verts, centroid, imgW, imgH, bbox, solidRatio, meta }
 */
export class ShapeExtractor {
  constructor(opts = {}) {
    this.alphaThreshold = opts.alphaThreshold ?? 8;   // 0-255
    this.simplifyEps   = opts.simplifyEps ?? 1.2;     // pixels
    this.maxVerts      = opts.maxVerts ?? 80;
    this.inset         = opts.inset ?? 0.98;          // <1 shrink, >1 expand
    this.minArea       = opts.minArea ?? 120;         // px^2 (mask area)
    this.cache = new Map();
  }

  async load(texUrl, maskUrl) {
    const key = `${texUrl}||${maskUrl}`;
    if (this.cache.has(key)) return this.cache.get(key);

    const [tex, mask] = await Promise.all([this.#loadImage(texUrl), this.#loadImage(maskUrl)]);
    const res = this.#extract(mask, tex.width, tex.height);
    res.texUrl = texUrl;
    res.maskUrl = maskUrl;
    this.cache.set(key, res);
    return res;
  }

  async #loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
      img.src = url;
    });
  }

  #extract(maskImg, imgW, imgH) {
    const c = document.createElement("canvas");
    c.width = imgW; c.height = imgH;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, imgW, imgH);
    ctx.drawImage(maskImg, 0, 0);

    const { data } = ctx.getImageData(0, 0, imgW, imgH);

    // build solid map + bbox
    const solid = new Uint8Array(imgW * imgH);
    let minX = imgW, minY = imgH, maxX = -1, maxY = -1;
    let solidCount = 0;

    const thr = this.alphaThreshold;
    for (let y = 0; y < imgH; y++) {
      for (let x = 0; x < imgW; x++) {
        const a = data[(y * imgW + x) * 4 + 3];
        if (a > thr) {
          solid[y * imgW + x] = 1;
          solidCount++;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (solidCount === 0) {
      return {
        ok: false,
        reason: "mask has no solid pixels",
        verts: null,
        centroid: { x: imgW * 0.5, y: imgH * 0.5 },
        imgW, imgH,
        bbox: { x:0, y:0, w:imgW, h:imgH },
        solidRatio: 0,
        meta: { version: "v10" }
      };
    }

    const bboxW = (maxX - minX + 1);
    const bboxH = (maxY - minY + 1);
    const bboxArea = bboxW * bboxH;
    const solidRatio = solidCount / bboxArea;

    // too small -> rectangle fallback is safer
    if (solidCount < this.minArea) {
      return {
        ok: false,
        reason: "too small mask area",
        verts: null,
        centroid: { x: (minX+maxX+1)/2, y: (minY+maxY+1)/2 },
        imgW, imgH,
        bbox: { x:minX, y:minY, w:bboxW, h:bboxH },
        solidRatio,
        meta: { version: "v10", solidCount }
      };
    }

    // trace outer boundary (Moore neighbor)
    const start = this.#findBoundaryStart(solid, imgW, imgH);
    if (!start) {
      return {
        ok: false,
        reason: "no boundary pixel found",
        verts: null,
        centroid: { x: (minX+maxX+1)/2, y: (minY+maxY+1)/2 },
        imgW, imgH,
        bbox: { x:minX, y:minY, w:bboxW, h:bboxH },
        solidRatio,
        meta: { version: "v10" }
      };
    }

    const raw = this.#traceBoundary(solid, imgW, imgH, start.x, start.y);
    if (!raw || raw.length < 30) {
      return {
        ok: false,
        reason: "contour too short",
        verts: null,
        centroid: { x: (minX+maxX+1)/2, y: (minY+maxY+1)/2 },
        imgW, imgH,
        bbox: { x:minX, y:minY, w:bboxW, h:bboxH },
        solidRatio,
        meta: { version: "v10", rawLen: raw?.length ?? 0 }
      };
    }

    // simplify
    let pts = this.#rdp(raw, this.simplifyEps);

    // cap verts
    if (pts.length > this.maxVerts) {
      const step = pts.length / this.maxVerts;
      const reduced = [];
      for (let i = 0; i < this.maxVerts; i++) reduced.push(pts[Math.floor(i * step)]);
      pts = reduced;
    }

    // ensure closed-ish (rdp keeps endpoints; boundary is loop, so enforce)
    if (pts.length >= 3) {
      const a = pts[0], b = pts[pts.length - 1];
      const d2 = (a.x - b.x)**2 + (a.y - b.y)**2;
      if (d2 < 4) pts.pop();
    }

    if (pts.length < 12) {
      return {
        ok: false,
        reason: "simplified contour too few points",
        verts: null,
        centroid: { x: (minX+maxX+1)/2, y: (minY+maxY+1)/2 },
        imgW, imgH,
        bbox: { x:minX, y:minY, w:bboxW, h:bboxH },
        solidRatio,
        meta: { version: "v10", pts: pts.length }
      };
    }

    const centroid = this.#polygonCentroid(pts) ?? { x: (minX+maxX+1)/2, y: (minY+maxY+1)/2 };

    // center + inset
    const verts = pts.map(p => ({
      x: (p.x - centroid.x) * this.inset,
      y: (p.y - centroid.y) * this.inset
    }));

    return {
      ok: true,
      reason: null,
      verts,
      centroid,
      imgW, imgH,
      bbox: { x:minX, y:minY, w:bboxW, h:bboxH },
      solidRatio,
      meta: { version: "v10", solidCount, rawLen: raw.length, simpLen: pts.length }
    };
  }

  #isSolid(solid, w, h, x, y) {
    if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    return solid[y * w + x] ? 1 : 0;
  }

  #findBoundaryStart(solid, w, h) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!this.#isSolid(solid, w, h, x, y)) continue;
        // boundary if any 4-neighbor is empty or outside
        if (!this.#isSolid(solid, w, h, x-1, y) ||
            !this.#isSolid(solid, w, h, x+1, y) ||
            !this.#isSolid(solid, w, h, x, y-1) ||
            !this.#isSolid(solid, w, h, x, y+1)) {
          return { x, y };
        }
      }
    }
    return null;
  }

  #traceBoundary(solid, w, h, sx, sy) {
    // Moore-Neighbor tracing (8-neighborhood)
    const dirs = [
      {x:1,y:0},{x:1,y:1},{x:0,y:1},{x:-1,y:1},
      {x:-1,y:0},{x:-1,y:-1},{x:0,y:-1},{x:1,y:-1}
    ];

    const start = { x: sx, y: sy };
    let cur = { x: sx, y: sy };
    let prev = { x: sx - 1, y: sy }; // backtrack starts from left
    const out = [];

    const maxSteps = w * h * 2;
    let steps = 0;

    function dirIndex(from, to) {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      for (let i = 0; i < 8; i++) if (dirs[i].x === dx && dirs[i].y === dy) return i;
      return 0;
    }

    const firstNext = { x: null, y: null };

    while (steps++ < maxSteps) {
      // record as pixel-center point
      out.push({ x: cur.x + 0.5, y: cur.y + 0.5 });

      const k = dirIndex(cur, prev);
      // search neighbors clockwise starting from k+1
      let next = null;
      let nextPrev = null;

      for (let i = 1; i <= 8; i++) {
        const idx = (k + i) % 8;
        const nx = cur.x + dirs[idx].x;
        const ny = cur.y + dirs[idx].y;
        if (this.#isSolid(solid, w, h, nx, ny)) {
          next = { x: nx, y: ny };
          // backtrack is the neighbor before next (counter-clockwise from next)
          const backIdx = (idx + 6) % 8; // idx-2
          nextPrev = { x: cur.x + dirs[backIdx].x, y: cur.y + dirs[backIdx].y };
          break;
        }
      }

      if (!next) break;

      // store first step to detect loop end robustly
      if (firstNext.x === null) {
        firstNext.x = next.x; firstNext.y = next.y;
      } else {
        // loop complete
        if (cur.x === start.x && cur.y === start.y && next.x === firstNext.x && next.y === firstNext.y) {
          break;
        }
      }

      prev = nextPrev;
      cur = next;
    }

    return out;
  }

  #rdp(points, eps) {
    if (points.length <= 2) return points;
    const first = points[0], last = points[points.length - 1];

    let maxDist = 0;
    let index = 0;

    for (let i = 1; i < points.length - 1; i++) {
      const d = this.#perpDist(points[i], first, last);
      if (d > maxDist) { maxDist = d; index = i; }
    }

    if (maxDist > eps) {
      const left = this.#rdp(points.slice(0, index + 1), eps);
      const right = this.#rdp(points.slice(index), eps);
      return left.slice(0, -1).concat(right);
    } else {
      return [first, last];
    }
  }

  #perpDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx*dx + dy*dy);
    const x = a.x + t * dx;
    const y = a.y + t * dy;
    return Math.hypot(p.x - x, p.y - y);
  }

  #polygonCentroid(pts) {
    // centroid by area (works for simple polygon)
    let a = 0, cx = 0, cy = 0;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      const cross = p.x * q.y - q.x * p.y;
      a += cross;
      cx += (p.x + q.x) * cross;
      cy += (p.y + q.y) * cross;
    }
    a *= 0.5;
    if (Math.abs(a) < 1e-6) return null;
    cx /= (6 * a);
    cy /= (6 * a);
    return { x: cx, y: cy };
  }
}
