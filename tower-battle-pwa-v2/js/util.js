export function clamp(v, lo, hi){
  return Math.max(lo, Math.min(hi, v));
}

export function rdpSimplify(points, epsilon){
  // Ramer–Douglas–Peucker
  if (points.length < 3) return points.slice();
  const sqEps = epsilon * epsilon;

  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while(stack.length){
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;

    const ax = points[a].x, ay = points[a].y;
    const bx = points[b].x, by = points[b].y;

    const dx = bx - ax, dy = by - ay;
    const len2 = dx*dx + dy*dy || 1;

    for(let i=a+1;i<b;i++){
      const px = points[i].x, py = points[i].y;
      // distance point to segment squared
      let t = ((px-ax)*dx + (py-ay)*dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + t*dx, cy = ay + t*dy;
      const ddx = px - cx, ddy = py - cy;
      const d2 = ddx*ddx + ddy*ddy;
      if (d2 > maxD){
        maxD = d2; idx = i;
      }
    }
    if (maxD > sqEps && idx !== -1){
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }

  const out = [];
  for(let i=0;i<points.length;i++){
    if (keep[i]) out.push(points[i]);
  }
  return out;
}

export function limitVertices(points, max){
  if (points.length <= max) return points;
  const out = [];
  const step = points.length / max;
  for (let i=0;i<max;i++){
    out.push(points[Math.floor(i*step)]);
  }
  return out;
}
