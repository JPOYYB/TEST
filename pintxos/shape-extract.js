/* shape-extract.js v8
   - largest connected component
   - hull fallback (never RECT unless everything fails)
   - DEBUG互換: fallback/verts/parts/xOffset/yOffset など復活
*/

(function () {
  const cache = new Map();
  const DEBUG = { enabled: true, last: null };

  function setDebug(on){ DEBUG.enabled = !!on; }
  function log(...a){ if(DEBUG.enabled) console.log(...a); }
  function warn(...a){ if(DEBUG.enabled) console.warn(...a); }

  function ensureDecomp() {
    try {
      if (window.Matter?.Common?.setDecomp && window.decomp) {
        window.Matter.Common.setDecomp(window.decomp);
      }
    } catch(_) {}
  }

  function loadImage(src){
    return new Promise((resolve, reject)=>{
      const img = new Image();
      img.onload = ()=>resolve(img);
      img.onerror = ()=>reject(new Error("Image load error: " + src));
      img.src = src;
    });
  }

  function polygonArea(pts){
    let a=0;
    for(let i=0;i<pts.length;i++){
      const p=pts[i], q=pts[(i+1)%pts.length];
      a += (p.x*q.y - q.x*p.y);
    }
    return a/2;
  }
  function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }

  function resampleClosed(points, N){
    if(!points || points.length<3) return points;
    const ring=[];
    for(const p of points){
      const prev = ring[ring.length-1];
      if(!prev || prev.x!==p.x || prev.y!==p.y) ring.push(p);
    }
    if(ring.length<3) return ring;

    const M=ring.length;
    const cum=[0];
    let perim=0;
    for(let i=0;i<M;i++){
      perim += dist(ring[i], ring[(i+1)%M]);
      cum.push(perim);
    }
    if(perim<=1e-6) return ring;

    const step = perim / N;
    const out=[];
    let seg=0;

    for(let k=0;k<N;k++){
      const target = k*step;
      while(seg<M && cum[seg+1]<target) seg++;
      const a=ring[seg%M], b=ring[(seg+1)%M];
      const segLen = dist(a,b) || 1e-6;
      const segStart = cum[seg];
      const t = Math.min(1, Math.max(0, (target - segStart)/segLen));
      out.push({ x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t });
    }
    return out;
  }

  function erode(mask, W, H, iter){
    let m=mask;
    for(let it=0; it<iter; it++){
      const out = new Uint8Array(W*H);
      for(let y=1;y<H-1;y++){
        for(let x=1;x<W-1;x++){
          const i=y*W+x;
          if(!m[i]) continue;
          let ok=1;
          for(let dy=-1;dy<=1 && ok;dy++){
            for(let dx=-1;dx<=1;dx++){
              if(!m[(y+dy)*W+(x+dx)]){ ok=0; break; }
            }
          }
          if(ok) out[i]=1;
        }
      }
      m=out;
    }
    return m;
  }

  function largestComponent(mask, W, H){
    const vis = new Uint8Array(W*H);
    const neigh = [-1, 1, -W, W, -W-1, -W+1, W-1, W+1];
    let bestCount=0, bestIdxs=null, comps=0;

    for(let i=0;i<W*H;i++){
      if(!mask[i] || vis[i]) continue;
      comps++;
      const q=[i];
      vis[i]=1;
      const idxs=[];
      while(q.length){
        const p=q.pop();
        idxs.push(p);
        const y = Math.floor(p/W), x = p - y*W;

        for(const d of neigh){
          const n = p + d;
          if(n<0 || n>=W*H) continue;

          // row wrap guard
          if((d===-1 || d===-W-1 || d===W-1) && x===0) continue;
          if((d===1  || d===-W+1 || d===W+1) && x===W-1) continue;

          if(mask[n] && !vis[n]){
            vis[n]=1;
            q.push(n);
          }
        }
      }
      if(idxs.length > bestCount){
        bestCount = idxs.length;
        bestIdxs = idxs;
      }
    }

    const out = new Uint8Array(W*H);
    if(bestIdxs) for(const p of bestIdxs) out[p]=1;
    return { out, comps, bestCount };
  }

  function buildBoundary(mask, W, H){
    const boundary = new Uint8Array(W*H);
    let sx=-1, sy=-1;
    for(let y=1;y<H-1;y++){
      for(let x=1;x<W-1;x++){
        const idx=y*W+x;
        if(!mask[idx]) continue;
        if(!mask[idx-1] || !mask[idx+1] || !mask[idx-W] || !mask[idx+W]){
          boundary[idx]=1;
          if(sy===-1 || y<sy || (y===sy && x<sx)){ sx=x; sy=y; }
        }
      }
    }
    return { boundary, sx, sy };
  }

  function traceMoore(boundary, W, H, sx, sy){
    const dirs=[
      {x:1,y:0},{x:1,y:1},{x:0,y:1},{x:-1,y:1},
      {x:-1,y:0},{x:-1,y:-1},{x:0,y:-1},{x:1,y:-1}
    ];
    const dirIndex=(dx,dy)=>{
      for(let i=0;i<8;i++) if(dirs[i].x===dx && dirs[i].y===dy) return i;
      return 0;
    };

    let x=sx, y=sy;
    let bx=sx-1, by=sy;
    const startX=x, startY=y;
    const out=[];
    const safety=W*H*10;
    let steps=0;

    do{
      out.push({x,y});
      const bi = dirIndex(x-bx, y-by);
      let found=false;
      for(let k=0;k<8;k++){
        const idx=(bi+1+k)%8;
        const nx=x+dirs[idx].x, ny=y+dirs[idx].y;
        if(nx<0||nx>=W||ny<0||ny>=H) continue;
        if(boundary[ny*W+nx]){
          const pb=(idx+7)%8;
          bx=x+dirs[pb].x; by=y+dirs[pb].y;
          x=nx; y=ny;
          found=true;
          break;
        }
      }
      if(!found) break;
      if(++steps>safety) break;
    } while(!(x===startX && y===startY));

    return out;
  }

  function collectEdgePoints(mask, W, H, maxPts=5000){
    const pts=[];
    let step=1;
    const approx = W*H/3;
    if(approx>maxPts) step = Math.ceil(approx/maxPts);

    let c=0;
    for(let y=1;y<H-1;y++){
      for(let x=1;x<W-1;x++){
        const idx=y*W+x;
        if(!mask[idx]) continue;
        if(!mask[idx-1] || !mask[idx+1] || !mask[idx-W] || !mask[idx+W]){
          if((c++%step)===0) pts.push({x,y});
        }
      }
    }
    return pts;
  }

  async function extract(maskPath, cfg={}){
    if(cache.has(maskPath)) return cache.get(maskPath);

    const promise = (async ()=>{
      const out = { ok:false, reason:"", maskPath };

      try{
        const img = await loadImage(maskPath);
        const iw=img.naturalWidth, ih=img.naturalHeight;
        if(!iw || !ih){ out.reason="natural size 0"; return out; }

        // ★ ここは現実寄り：境界の半透明も拾う
        const alphaThreshold = cfg.alphaThreshold ?? cfg.threshold ?? 1;
        const nPoints = cfg.nPoints ?? 140;
        const padPx = cfg.padPx ?? 2;
        const analysisMax = cfg.analysisMax ?? 460;
        const minContour = cfg.minContour ?? 20;
        const erodePx = cfg.erodePx ?? 0;

        // scan full image for bbox + centroid
        const base=document.createElement("canvas");
        base.width=iw; base.height=ih;
        const bctx=base.getContext("2d",{willReadFrequently:true});
        bctx.clearRect(0,0,iw,ih);
        bctx.drawImage(img,0,0);

        let imgData;
        try{ imgData = bctx.getImageData(0,0,iw,ih); }
        catch(e){ out.reason="getImageData failed (tainted?)"; return out; }

        const data=imgData.data;
        let solid=0, sumX=0, sumY=0;
        let minX=iw, minY=ih, maxX=-1, maxY=-1;

        for(let y=0;y<ih;y++){
          for(let x=0;x<iw;x++){
            const i=(y*iw+x)*4;
            const a=data[i+3];
            if(a>alphaThreshold){
              solid++; sumX+=x; sumY+=y;
              if(x<minX)minX=x; if(y<minY)minY=y;
              if(x>maxX)maxX=x; if(y>maxY)maxY=y;
            }
          }
        }
        if(solid<60){ out.reason="too few solid pixels (mask empty?)"; return out; }

        const solidRatio = solid/(iw*ih);
        const cx0 = sumX/solid, cy0=sumY/solid;
        const bboxW=maxX-minX+1, bboxH=maxY-minY+1;

        const cropX=Math.max(0,minX-padPx);
        const cropY=Math.max(0,minY-padPx);
        const cropX2=Math.min(iw-1,maxX+padPx);
        const cropY2=Math.min(ih-1,maxY+padPx);
        const cropW=cropX2-cropX+1;
        const cropH=cropY2-cropY+1;

        // upscale analysis
        const scale = analysisMax/Math.max(cropW,cropH);
        const s = Math.min(12.0, Math.max(1.0, scale));
        const W=Math.max(96, Math.round(cropW*s));
        const H=Math.max(96, Math.round(cropH*s));
        const inv=1/s;

        const ac=document.createElement("canvas");
        ac.width=W; ac.height=H;
        const actx=ac.getContext("2d",{willReadFrequently:true});
        actx.clearRect(0,0,W,H);
        actx.drawImage(img,cropX,cropY,cropW,cropH,0,0,W,H);

        const aData=actx.getImageData(0,0,W,H).data;
        let mask=new Uint8Array(W*H);
        let aSolid=0;
        for(let y=0;y<H;y++){
          for(let x=0;x<W;x++){
            const i=(y*W+x)*4;
            if(aData[i+3]>alphaThreshold){
              mask[y*W+x]=1;
              aSolid++;
            }
          }
        }
        if(aSolid<120){ out.reason="cropped solid too small"; return out; }

        if(erodePx>0) mask = erode(mask, W, H, erodePx);

        // ★ 最大連結成分だけ採用（ゴミ点を完全無視）
        const cc = largestComponent(mask, W, H);
        const compMask = cc.out;

        // trace boundary
        const { boundary, sx, sy } = buildBoundary(compMask, W, H);
        let contour=null, contourLen=0, usedHull=false;

        if(sx!==-1){
          const c = traceMoore(boundary, W, H, sx, sy);
          contourLen = c?.length ?? 0;
          if(c && c.length >= minContour){
            contour = c.map(p=>({
              x:(cropX + p.x*inv) - cx0,
              y:(cropY + p.y*inv) - cy0
            }));
          }
        }

        // hull fallback
        if(!contour){
          const Matter = window.Matter;
          if(!Matter?.Vertices?.hull){
            out.reason="contour too short (Vertices.hull missing)";
            return out;
          }
          const edgePts = collectEdgePoints(compMask, W, H, 6000);
          if(edgePts.length < 12){
            out.reason="contour too short (edge pts too few)";
            return out;
          }
          const hull = Matter.Vertices.hull(edgePts);
          if(!hull || hull.length < 6){
            out.reason="contour too short (hull failed)";
            return out;
          }
          contour = hull.map(p=>({
            x:(cropX + p.x*inv) - cx0,
            y:(cropY + p.y*inv) - cy0
          }));
          contourLen = hull.length;
          usedHull = true;
        }

        let pts = resampleClosed(contour, nPoints);
        if(!pts || pts.length<12){ out.reason="resample failed"; return out; }
        if(polygonArea(pts)>0) pts.reverse(); // clockwise

        out.ok=true;
        out.pts=pts;
        out.iw=iw; out.ih=ih;
        out.bw=bboxW; out.bh=bboxH;
        out.xOffset=Math.max(0,Math.min(1,cx0/iw));
        out.yOffset=Math.max(0,Math.min(1,cy0/ih));
        out.solidRatio=solidRatio;
        out._dbg={
          version:"v8",
          bboxW,bboxH,cropW,cropH,
          analysisW:W, analysisH:H, analysisScale:s,
          comps:cc.comps, bestCount:cc.bestCount,
          contourLen, usedHull
        };

        DEBUG.last = out;
        return out;

      } catch(e){
        out.reason = e.message || String(e);
        warn("[ShapeExtract] failed:", out);
        return out;
      }
    })();

    cache.set(maskPath, promise);
    return promise;
  }

  async function makeBody(texturePath, x, y, opt={}){
    const Matter = window.Matter;
    if(!Matter) throw new Error("Matter.js not loaded");
    ensureDecomp();

    const maskPath = opt.maskPath ?? texturePath;
    const packed = await extract(maskPath, opt.shapeCfg ?? {});

    const targetSize = opt.targetSize ?? 150;
    const hitInset   = opt.hitInset ?? 0.985; // 詰めたいので少し攻める
    const bw = packed?.bw || 1, bh = packed?.bh || 1;
    const spriteScale = targetSize / Math.max(bw, bh);

    const bodyOpts = Object.assign({
      label:"Pintxo",
      restitution:0.05,
      friction:0.95
    }, opt.bodyOpts || {});

    let body=null;
    let usedFallback=false;
    let reason="";

    if(packed && packed.ok){
      try{
        body = Matter.Bodies.fromVertices(x, y, [packed.pts], bodyOpts, true);
      } catch(e){
        body=null;
        usedFallback=true;
        reason="fromVertices threw: " + (e.message||e);
      }
    } else {
      usedFallback=true;
      reason = packed?.reason || "extract failed";
    }

    // last resort RECT (本来ここには来ない)
    if(!body){
      body = Matter.Bodies.rectangle(x, y, targetSize, targetSize, bodyOpts);
      body.__dbg_forceRect = true;
      usedFallback = true;
      if(!reason) reason="rect fallback";
    }

    // scale collider
    Matter.Body.scale(body, spriteScale * hitInset, spriteScale * hitInset);

    // sprite
    body.render = body.render || {};
    body.render.sprite = {
      texture: texturePath,
      xScale: spriteScale,
      yScale: spriteScale,
      xOffset: packed?.xOffset ?? 0.5,
      yOffset: packed?.yOffset ?? 0.5
    };

    // ★あなたのDEBUG互換キー（ここが本題）
    const xOff = body.render.sprite.xOffset ?? 0.5;
    const yOff = body.render.sprite.yOffset ?? 0.5;

    body.__dbg = {
      // 表示が || で潰されないように「文字列」も持たせる
      fallback: usedFallback ? "true" : "false",
      fallbackBool: usedFallback,
      reason: usedFallback ? reason : "",
      verts: body.vertices ? body.vertices.length : 0,
      parts: body.parts ? body.parts.length : 0,
      xOffset: xOff,
      yOffset: yOff,
      solidRatio: packed?.solidRatio,
      spriteScale: spriteScale,
      hitInset: hitInset,
      hasDecomp: !!window.decomp,
      version: "v8",
      tex: texturePath,
      mask: maskPath,
      dbg: packed?._dbg || null,
      forcedRect: !!body.__dbg_forceRect
    };

    return body;
  }

  window.ShapeExtract = {
    VERSION: "v8",
    extract, makeBody, setDebug,
    _debugLast: ()=>DEBUG.last
  };
})();
