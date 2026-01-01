import { rdpSimplify, limitVertices } from './util.js';

/**
 * 透過PNGのアルファから「外周輪郭」を抽出して、Matter.js用の頂点列を返します。
 * - 透過部分は当たり判定から除外（外周のみ。内部の穴は考慮しません）
 * - 形が複雑でも“ひっかかり”が出やすいよう、凹形状も残せる設定にしています。
 *
 * 設定（config/config.json）:
 *  PHYSICS.outlineAlphaThreshold
 *  PHYSICS.outlineSampleScale
 *  PHYSICS.outlineSimplifyEpsilon
 *  PHYSICS.outlineMaxVertices
 */
export async function verticesFromImage(img, cfg){
  const thr = cfg.PHYSICS?.outlineAlphaThreshold ?? 6;
  const scale = cfg.PHYSICS?.outlineSampleScale ?? 0.32;
  const eps = cfg.PHYSICS?.outlineSimplifyEpsilon ?? 1.8;
  const maxV = cfg.PHYSICS?.outlineMaxVertices ?? 120;

  const w = Math.max(16, Math.floor(img.naturalWidth * scale));
  const h = Math.max(16, Math.floor(img.naturalHeight * scale));

  const cvs = document.createElement('canvas');
  cvs.width = w; cvs.height = h;
  const ctx = cvs.getContext('2d', { willReadFrequently: true });

  ctx.clearRect(0,0,w,h);
  ctx.drawImage(img, 0, 0, w, h);

  const { data } = ctx.getImageData(0,0,w,h);
  const mask = new Uint8Array(w*h);
  let solidCount = 0;

  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const a = data[(y*w + x)*4 + 3];
      if (a > thr){
        mask[y*w + x] = 1;
        solidCount++;
      }
    }
  }
  if (solidCount < 20) return null;

  // boundary pixels (4-neighborhood)
  const boundary = new Uint8Array(w*h);
  let bx = -1, by = -1;
  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      const i = y*w + x;
      if (!mask[i]) continue;
      if (!mask[i-1] || !mask[i+1] || !mask[i-w] || !mask[i+w]){
        boundary[i] = 1;
        if (by === -1 || y < by || (y === by && x < bx)){
          bx = x; by = y; // top-leftmost boundary pixel
        }
      }
    }
  }
  if (bx === -1) return null;

  const contour = traceMoore(boundary, w, h, bx, by);
  if (!contour || contour.length < 24) return null;

  // center + scale back
  const invScale = 1/scale;
  const cx = w/2;
  const cy = h/2;
  let pts = contour.map(p => ({
    x: (p.x - cx) * invScale,
    y: (p.y - cy) * invScale
  }));

  // simplify and cap
  pts = rdpSimplify(pts, eps * invScale);
  pts = limitVertices(pts, maxV);
  pts = dedupeClose(pts, 0.7 * invScale);

  if (pts.length < 8) return null;
  // ensure clockwise (Matter prefers, but not mandatory)
  if (polygonArea(pts) > 0) pts.reverse();

  return pts;
}

function traceMoore(boundary, w, h, sx, sy){
  // 8 directions (clockwise)
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

  // start at boundary pixel; set backtrack to west
  let x = sx, y = sy;
  let bx = sx - 1, by = sy;

  const start = {x, y};
  const contour = [];
  const safety = w*h*8;
  let steps = 0;

  do{
    contour.push({x, y});

    // direction index from back -> current
    let bi = dirIndex(x - bx, y - by, dirs);

    // search neighbors clockwise starting from bi+1 (standard Moore)
    let found = false;
    for(let k=0;k<8;k++){
      const idx = (bi + 1 + k) % 8;
      const nx = x + dirs[idx].x;
      const ny = y + dirs[idx].y;
      if (nx<0 || nx>=w || ny<0 || ny>=h) continue;
      if (boundary[ny*w + nx]){
        // next back is previous neighbor
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
  } while(!(x === start.x && y === start.y));

  return contour;
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
    if (!prev){ out.push(p); continue; }
    const dx = p.x - prev.x, dy = p.y - prev.y;
    if (dx*dx + dy*dy >= md2) out.push(p);
  }
  if (out.length > 3){
    const a = out[0], b = out[out.length-1];
    const dx = a.x-b.x, dy = a.y-b.y;
    if (dx*dx + dy*dy < md2) out.pop();
  }
  return out;
}
