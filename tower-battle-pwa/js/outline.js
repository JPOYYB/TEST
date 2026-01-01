import { rdpSimplify, limitVertices } from './util.js';

/**
 * Create polygon vertices from a transparent PNG by tracing the outer boundary.
 * This is intentionally "good enough" and configurable for speed.
 *
 * Strategy:
 *  1) Draw scaled image to offscreen canvas
 *  2) Build binary alpha mask (alpha > threshold)
 *  3) Trace outer boundary with Moore-neighbor tracing (8-neighborhood)
 *  4) Simplify and cap vertices
 *
 * If tracing fails, return null (caller falls back to rectangle).
 */
export async function verticesFromImage(img, cfg){
  const thr = cfg.PHYSICS?.outlineAlphaThreshold ?? 8;
  const scale = cfg.PHYSICS?.outlineSampleScale ?? 0.25;
  const eps = cfg.PHYSICS?.outlineSimplifyEpsilon ?? 2.2;
  const maxV = cfg.PHYSICS?.outlineMaxVertices ?? 90;

  const w = Math.max(8, Math.floor(img.naturalWidth * scale));
  const h = Math.max(8, Math.floor(img.naturalHeight * scale));

  const cvs = document.createElement('canvas');
  cvs.width = w; cvs.height = h;
  const ctx = cvs.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0,0,w,h);
  ctx.drawImage(img, 0, 0, w, h);

  const { data } = ctx.getImageData(0,0,w,h);
  const mask = new Uint8Array(w*h);

  let found = false;
  let sx = 0, sy = 0;
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const a = data[(y*w + x)*4 + 3];
      if (a > thr){
        mask[y*w + x] = 1;
        if (!found){
          found = true;
          sx = x; sy = y;
        }
      }
    }
  }
  if (!found) return null;

  // Moore-Neighbor tracing
  const dirs = [
    {x: 1, y: 0},  // E
    {x: 1, y: 1},  // SE
    {x: 0, y: 1},  // S
    {x:-1, y: 1},  // SW
    {x:-1, y: 0},  // W
    {x:-1, y:-1},  // NW
    {x: 0, y:-1},  // N
    {x: 1, y:-1},  // NE
  ];

  // Start: boundary pixel near sx,sy. We already found a solid pixel; ensure it's on boundary by moving left until edge.
  let x = sx, y = sy;
  while(x>0 && mask[y*w + (x-1)] === 1) x--;

  const start = {x, y};
  let back = {x: x-1, y}; // backtrack point
  const contour = [];
  const limit = w*h*6; // safety

  let steps = 0;
  do{
    contour.push({x, y});
    // find neighbor starting from direction of back->current
    let bi = dirIndex(x - back.x, y - back.y, dirs);
    // scan neighbors clockwise
    let foundNext = null;
    let nextBack = null;

    for(let i=0;i<8;i++){
      const idx = (bi + 6 + i) % 8; // start a bit counterclockwise
      const nx = x + dirs[idx].x;
      const ny = y + dirs[idx].y;
      if (nx>=0 && nx<w && ny>=0 && ny<h && mask[ny*w + nx] === 1){
        foundNext = {x:nx, y:ny};
        // back becomes the neighbor before foundNext in clockwise order
        const bidx = (idx + 7) % 8;
        nextBack = {x: x + dirs[bidx].x, y: y + dirs[bidx].y};
        break;
      }
    }

    if (!foundNext) break;

    back = nextBack;
    x = foundNext.x;
    y = foundNext.y;

    steps++;
    if (steps > limit) break;
  } while(!(x===start.x && y===start.y));

  if (contour.length < 12) return null;

  // Convert to centered coordinates and scale back to original pixels
  // We use pixel centers; also invert y later in drawing is handled elsewhere.
  const invScale = 1 / scale;
  const cx = w / 2;
  const cy = h / 2;

  let pts = contour.map(p => ({
    x: (p.x - cx) * invScale,
    y: (p.y - cy) * invScale
  }));

  // Simplify and cap vertices
  pts = rdpSimplify(pts, eps * invScale);
  pts = limitVertices(pts, maxV);

  // Remove near-duplicates
  pts = dedupeClose(pts, 0.8 * invScale);

  // Ensure clockwise order for Matter (it can handle either but prefer)
  if (polygonArea(pts) > 0){
    pts.reverse();
  }

  return pts;
}

function dirIndex(dx, dy, dirs){
  for(let i=0;i<dirs.length;i++){
    if (dirs[i].x === dx && dirs[i].y === dy) return i;
  }
  return 0;
}

function polygonArea(pts){
  let a=0;
  for(let i=0;i<pts.length;i++){
    const p=pts[i], q=pts[(i+1)%pts.length];
    a += (p.x*q.y - q.x*p.y);
  }
  return a/2;
}

function dedupeClose(pts, minDist){
  const out = [];
  const md2 = minDist*minDist;
  for (let i=0;i<pts.length;i++){
    const p = pts[i];
    const prev = out[out.length-1];
    if (!prev){
      out.push(p); continue;
    }
    const dx = p.x - prev.x, dy = p.y - prev.y;
    if (dx*dx + dy*dy >= md2) out.push(p);
  }
  // Close loop dedupe
  if (out.length > 3){
    const a = out[0], b = out[out.length-1];
    const dx = a.x-b.x, dy = a.y-b.y;
    if (dx*dx + dy*dy < md2) out.pop();
  }
  return out;
}
