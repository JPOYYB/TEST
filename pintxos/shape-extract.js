/* shape-extract.js
 * - mask PNG の “アルファ” から輪郭を抽出して Matter.js 用の頂点配列を作る
 * - 重要: mask は元画像と同サイズ・同位置（トリミング禁止）
 */
(() => {
  const ShapeExtract = {};
  const DEFAULTS = {
    alphaThreshold: 8,     // 0-255
    dilate: 1,             // 0-2 推奨（細い串などは 1 が効く）
    simplifyEps: 1.2,      // 大きいほど荒くなる
    maxPoints: 64,         // 多すぎると分解が重い
    minArea: 40,           // 小さすぎる輪郭はfallback
  };

  function loadImage(url, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Image load failed: ${url}`));
      img.src = url;
      setTimeout(() => reject(new Error(`Image timeout: ${url}`)), timeoutMs);
    });
  }

  function getAlphaMap(img, w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0,0,w,h);
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0,0,w,h).data;
    return { data, canvas: c, ctx };
  }

  function dilateBinary(bin, w, h, steps) {
    if (steps <= 0) return bin;
    let cur = bin.slice();
    let nxt = new Uint8Array(cur.length);
    const idx = (x,y)=> y*w+x;

    for (let s=0; s<steps; s++) {
      nxt.fill(0);
      for (let y=0; y<h; y++) for (let x=0; x<w; x++) {
        const i = idx(x,y);
        if (!cur[i]) continue;
        // 8近傍を立てる
        for (let dy=-1; dy<=1; dy++) for (let dx=-1; dx<=1; dx++) {
          const nx=x+dx, ny=y+dy;
          if (nx<0||ny<0||nx>=w||ny>=h) continue;
          nxt[idx(nx,ny)] = 1;
        }
      }
      cur = nxt.slice();
    }
    return cur;
  }

  function findBoundaryStart(bin, w, h) {
    const idx = (x,y)=> y*w+x;
    const isSolid = (x,y)=> (x>=0 && y>=0 && x<w && y<h) ? bin[idx(x,y)]===1 : false;
    for (let y=0; y<h; y++) for (let x=0; x<w; x++) {
      if (!isSolid(x,y)) continue;
      // 周囲に空があれば境界
      const neigh = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
      for (const [dx,dy] of neigh) {
        if (!isSolid(x+dx,y+dy)) return {x,y};
      }
    }
    return null;
  }

  // Moore-Neighbor Tracing (8方向)
  function traceBoundary(bin, w, h) {
    const start = findBoundaryStart(bin, w, h);
    if (!start) return [];
    const idx = (x,y)=> y*w+x;
    const isSolid = (x,y)=> (x>=0 && y>=0 && x<w && y<h) ? bin[idx(x,y)]===1 : false;

    const dirs = [
      [1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]
    ]; // 時計回り
    let cur = {x:start.x, y:start.y};
    let backDir = 4; // 直前は西から来た扱い
    const pts = [];
    const guardMax = 5000;

    for (let step=0; step<guardMax; step++) {
      pts.push({x:cur.x + 0.5, y:cur.y + 0.5}); // ピクセル中心
      let dir = (backDir + 1) & 7;
      let found = false;
      for (let k=0; k<8; k++) {
        const nx = cur.x + dirs[dir][0];
        const ny = cur.y + dirs[dir][1];
        if (isSolid(nx,ny)) {
          cur = {x:nx, y:ny};
          backDir = (dir + 4) & 7;
          found = true;
          break;
        }
        dir = (dir + 1) & 7;
      }
      if (!found) break;
      if (cur.x===start.x && cur.y===start.y && pts.length>20) break;
    }
    return pts;
  }

  function polygonArea(pts) {
    let a = 0;
    for (let i=0; i<pts.length; i++) {
      const p = pts[i];
      const q = pts[(i+1)%pts.length];
      a += (p.x*q.y - q.x*p.y);
    }
    return a * 0.5;
  }

  // RDP簡略化
  function rdp(points, eps) {
    if (points.length < 8) return points;

    const distToSeg = (p,a,b) => {
      const vx = b.x-a.x, vy = b.y-a.y;
      const wx = p.x-a.x, wy = p.y-a.y;
      const c1 = vx*wx + vy*wy;
      if (c1 <= 0) return Math.hypot(p.x-a.x, p.y-a.y);
      const c2 = vx*vx + vy*vy;
      if (c2 <= c1) return Math.hypot(p.x-b.x, p.y-b.y);
      const t = c1 / c2;
      const px = a.x + t*vx, py = a.y + t*vy;
      return Math.hypot(p.x-px, p.y-py);
    };

    const keep = new Uint8Array(points.length);
    keep[0]=1; keep[points.length-1]=1;

    function rec(s,e){
      let maxD=0, idx=-1;
      for (let i=s+1; i<e; i++) {
        const d = distToSeg(points[i], points[s], points[e]);
        if (d > maxD) { maxD=d; idx=i; }
      }
      if (maxD > eps && idx !== -1) {
        keep[idx]=1;
        rec(s, idx);
        rec(idx, e);
      }
    }
    rec(0, points.length-1);

    const out = [];
    for (let i=0; i<points.length; i++) if (keep[i]) out.push(points[i]);
    return out;
  }

  function resample(points, maxPoints) {
    if (points.length <= maxPoints) return points;
    const out = [];
    const step = points.length / maxPoints;
    for (let i=0; i<maxPoints; i++) {
      out.push(points[Math.floor(i*step)]);
    }
    return out;
  }

  function bboxFromAlpha(data, w, h, thr) {
    let minX=w, minY=h, maxX=-1, maxY=-1;
    let solid=0;
    for (let y=0; y<h; y++) for (let x=0; x<w; x++) {
      const a = data[(y*w+x)*4 + 3];
      if (a > thr) {
        solid++;
        if (x<minX) minX=x;
        if (y<minY) minY=y;
        if (x>maxX) maxX=x;
        if (y>maxY) maxY=y;
      }
    }
    if (maxX < 0) return null;
    return {minX, minY, maxX, maxY, solid};
  }

  ShapeExtract.extract = async function(maskUrl, opts={}) {
    const o = {...DEFAULTS, ...opts};
    const img = await loadImage(maskUrl);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;

    const {data} = getAlphaMap(img, w, h);
    const bb = bboxFromAlpha(data, w, h, o.alphaThreshold);
    if (!bb) {
      return { ok:false, fallback:true, reason:"empty mask", verts: null, meta:{w,h,solidRatio:0} };
    }
    const solidRatio = bb.solid / (w*h);

    // binary
    let bin = new Uint8Array(w*h);
    for (let y=0; y<h; y++) for (let x=0; x<w; x++) {
      const a = data[(y*w+x)*4 + 3];
      bin[y*w+x] = (a > o.alphaThreshold) ? 1 : 0;
    }
    bin = dilateBinary(bin, w, h, o.dilate);

    let contour = traceBoundary(bin, w, h);
    if (contour.length < 20) {
      // fallback: bbox rectangle（※ズレないように画像中心基準）
      const cx = w/2, cy = h/2;
      const rw = (bb.maxX - bb.minX + 1);
      const rh = (bb.maxY - bb.minY + 1);
      const x0 = (bb.minX - cx), x1 = (bb.minX + rw - cx);
      const y0 = (bb.minY - cy), y1 = (bb.minY + rh - cy);
      return {
        ok:false, fallback:true, reason:"contour too short",
        verts: [{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}],
        meta:{w,h,solidRatio,bbox:bb}
      };
    }

    // 閉曲線 → 開曲線にしてRDP
    contour.push({...contour[0]});
    contour = rdp(contour, o.simplifyEps);
    contour.pop();

    contour = resample(contour, o.maxPoints);

    // 画像中心を原点に
    const cx = w/2, cy = h/2;
    let verts = contour.map(p => ({x: p.x - cx, y: p.y - cy}));

    // 面積チェック（符号含む）
    const area = polygonArea(verts);
    if (Math.abs(area) < o.minArea) {
      const rw = (bb.maxX - bb.minX + 1);
      const rh = (bb.maxY - bb.minY + 1);
      const x0 = (bb.minX - cx), x1 = (bb.minX + rw - cx);
      const y0 = (bb.minY - cy), y1 = (bb.minY + rh - cy);
      verts = [{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}];
      return {
        ok:false, fallback:true, reason:"area too small -> rect",
        verts,
        meta:{w,h,solidRatio,bbox:bb}
      };
    }

    // 時計回り/反時計回りを安定化（Matterはどっちでも動くがデバッグが見やすい）
    if (area < 0) verts = verts.reverse();

    return {
      ok:true, fallback:false, reason:"-",
      verts,
      meta:{w,h,solidRatio,bbox:bb}
    };
  };

  ShapeExtract.loadAll = async function(list, opts={}) {
    const out = {};
    const results = [];
    for (const a of list) {
      try {
        const r = await ShapeExtract.extract(a.mask, opts);
        out[a.id] = r;
        results.push({id:a.id, ...r});
      } catch(e) {
        out[a.id] = { ok:false, fallback:true, reason:String(e), verts:null, meta:{} };
        results.push({id:a.id, ok:false, fallback:true, reason:String(e)});
      }
    }
    return { shapes: out, results };
  };

  window.ShapeExtract = ShapeExtract;
})();
