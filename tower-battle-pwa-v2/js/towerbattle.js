import { clamp } from './util.js';
import { verticesFromImage } from './outline.js';

const { Engine, World, Bodies, Body, Composite, Events, Vector } = Matter;

export class TowerBattle{
  constructor({ cfg, assets, canvas, onHud, onGameOver }){
    this.cfg = cfg;
    this.assets = assets;
    this.canvas = canvas;
    this.onHud = onHud;
    this.onGameOver = onGameOver;

    this.soundEnabled = !!cfg.SOUND?.enabledByDefault;

    this.ctx = canvas.getContext('2d', { alpha:false });
    this.engine = Engine.create();
    this.world = this.engine.world;

    // high DPI
    this.dpr = 1;
    this.w = 0; this.h = 0;

    this.running = false;

    // Controls
    this.moveDir = 0; // -1 left, 0 none, 1 right

    this.lastTs = 0;

    // Game state
    this.score = 0;
    this.lastScore = 0;
    this.timeLeft = 0;

    this.ground = null;
    this.walls = [];
    this.active = null; // current moving piece
    this.activeSprite = null;
    this.activeVertices = null;
    this.activeScale = cfg.SPRITES?.animalScale ?? 0.72;
    this.animalIndex = 0;

    this.scored = new Set();
    this.settleCounter = new Map();

    this.spriteMap = new Map(); // src -> Image
    this.verticesCache = new Map(); // src -> vertices array

    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize, { passive:true });

    this.resize();
  }

  setSoundEnabled(v){ this.soundEnabled = !!v; }

  getLastScore(){ return this.lastScore; }

  async start(){
    // reset world and state
    this.running = false;

    // Controls
    this.moveDir = 0; // -1 left, 0 none, 1 right

    World.clear(this.world, false);
    Engine.clear(this.engine);

    this.engine = Engine.create();
    this.world = this.engine.world;

    this.score = 0;
    this.timeLeft = 0;
    this.lastScore = 0;
    this.scored.clear();
    this.settleCounter.clear();

    this.world.gravity.y = this.cfg.GAME?.gravityY ?? 1.0;

    await this.prepareSprites();
    this.buildBounds();

    this.animalIndex = 0;
    await this.spawnNext(true);

    this.running = true;
    this.lastTs = performance.now();
    requestAnimationFrame((t) => this.loop(t));
  }

  async prepareSprites(){
    // preload images into map
    for (const a of (this.assets.animals ?? [])){
      if (this.spriteMap.has(a.src)) continue;
      const img = await loadImage(a.src);
      this.spriteMap.set(a.src, img);
    }
  }

  buildBounds(){
    const gh = this.cfg.GAME?.groundHeight ?? 110;
    const platformRatio = this.cfg.GAME?.platformWidthRatio ?? 0.70;
    const pw = Math.max(220, this.w * platformRatio);

    const yTop = this.h - gh; // platform top line (visual)
    this.platform = {
      xMin: (this.w - pw)/2,
      xMax: (this.w + pw)/2,
      yTop
    };

    // Narrow platform body
    const ground = Bodies.rectangle(this.w/2, this.h - gh/2, pw, gh, {
      isStatic: true,
      friction: 1,
      restitution: 0,
      label: 'platform'
    });

    // No side walls (falling off is allowed -> miss)
    this.ground = ground;
    this.walls = [];
    World.add(this.world, [ground]);
  }

  async spawnNext(makeStatic){
    // choose next animal
    const list = this.assets.animals ?? [];
    if (!list.length) throw new Error('No animals in assets.json');

    const a = list[this.animalIndex % list.length];
    this.animalIndex++;

    const img = this.spriteMap.get(a.src);
    const spriteScale = this.cfg.SPRITES?.animalScale ?? 0.72;

    // Get vertices from cache or compute
    let verts = this.verticesCache.get(a.src);
    if (!verts){
      // localStorage cache for speed across reloads
      const key = this.cacheKeyFor(a.src);
      const cached = tryLoadVertices(key);
      if (cached){
        verts = cached;
      } else {
        verts = await verticesFromImage(img, this.cfg);
        if (verts && verts.length >= 8){
          trySaveVertices(key, verts);
        }
      }
      this.verticesCache.set(a.src, verts);
    }

    const spawnY = this.cfg.GAME?.spawnY ?? 140;
    const moveRange = (this.cfg.GAME?.spawnMoveRangeRatio ?? 0.40) * this.w;
    const x0 = this.w/2;
    const x = x0;

    let body;
    if (verts && verts.length >= 8){
      // Matter wants vertices in world coords around body position. We provide relative vertices and then set position.
      // Use fromVertices which can handle concave with decomp.
      const scaled = verts.map(p => ({ x: p.x * spriteScale, y: p.y * spriteScale }));
      body = Bodies.fromVertices(x, spawnY, [scaled], this.bodyOpts(), true);
      // In some cases fromVertices returns a compound body; ensure position
      Body.setPosition(body, { x, y: spawnY });
    } else {
      // fallback rectangle based on sprite size
      const bw = img.naturalWidth * spriteScale * 0.8;
      const bh = img.naturalHeight * spriteScale * 0.8;
      body = Bodies.rectangle(x, spawnY, bw, bh, this.bodyOpts());
    }

    body.label = 'animal';
    body.renderSprite = { img, scale: spriteScale, src: a.src };

    if (makeStatic){
      Body.setStatic(body, true);
    }

    this.active = body;
    this.activeSprite = body.renderSprite;
    this.activeVertices = verts;

    World.add(this.world, body);
  }

  bodyOpts(){
    const p = this.cfg.PHYSICS ?? {};
    return {
      friction: p.friction ?? 0.9,
      frictionStatic: p.frictionStatic ?? 1.0,
      restitution: p.restitution ?? 0.06,
      density: p.density ?? 0.0016,
      chamfer: null
    };
  }

  cacheKeyFor(src){
    const v = this.cfg.VERSION ?? 1;
    const p = this.cfg.PHYSICS ?? {};
    return `tb_vtx_v${v}|${src}|thr${p.outlineAlphaThreshold ?? 8}|s${p.outlineSampleScale ?? 0.25}|e${p.outlineSimplifyEpsilon ?? 2.2}|m${p.outlineMaxVertices ?? 90}`;
  }

  setMoveDir(dir){
    this.moveDir = Math.max(-1, Math.min(1, dir|0));
  }

  drop(){
    if (!this.running) return;
    if (this.active && this.active.isStatic){
      Body.setStatic(this.active, false);
      Body.applyForce(this.active, this.active.position, {
        x: (Math.random() - 0.5) * 0.00012,
        y: 0
      });
      setTimeout(() => {
        if (this.running) this.spawnNext(true);
      }, 120);
    }
  }
  }

  loop(ts){
    if (!this.running) return;

    const dtMs = Math.min(32, ts - this.lastTs);
    this.lastTs = ts;

    const fps = this.cfg.GAME?.fps ?? 60;
    Engine.update(this.engine, 1000 / fps);

    // Move active preview by button
    if (this.active && this.active.isStatic){
      const speed = this.cfg.GAME?.spawnMoveSpeedPx ?? 7.5;
      const dx = this.moveDir * speed * (dtMs / (1000/60));
      const margin = 18;
      const minX = (this.platform?.xMin ?? 0) + margin;
      const maxX = (this.platform?.xMax ?? this.w) - margin;
      const nx = clamp(this.active.position.x + dx, minX, maxX);
      Body.setPosition(this.active, { x: nx, y: this.active.position.y });
    }

    // scoring: detect bodies that have settled
    this.updateScoring();

    // fail condition:
 any body fell below screen
    const failY = this.h + (this.cfg.GAME?.failYMargin ?? 260);
    const animals = Composite.allBodies(this.world).filter(b => b.label === 'animal' && !b.isStatic);
    for (const b of animals){
      // Miss: fell off platform (x outside platform bounds) and below platform top
      if (this.platform){
        const offX = (b.position.x < this.platform.xMin || b.position.x > this.platform.xMax);
        const belowTop = (b.position.y > this.platform.yTop + 12);
        if (offX && belowTop){
          this.gameOver();
          return;
        }
      }

      if (b.position.y > failY){
        this.gameOver();
        return;
      }
    }

    this.render();

    requestAnimationFrame((t) => this.loop(t));
  }

  updateScoring(){
    const settleV = this.cfg.GAME?.settleSpeed ?? 0.12;
    const settleW = this.cfg.GAME?.settleAngularSpeed ?? 0.12;
    const need = this.cfg.GAME?.settleFramesNeeded ?? 18;

    const per = this.cfg.SCORING?.perAnimal ?? 10;

    const animals = Composite.allBodies(this.world).filter(b => b.label === 'animal' && !b.isStatic);
    for (const b of animals){
      if (this.scored.has(b.id)) continue;

      const v = b.velocity;
      const s = Math.hypot(v.x, v.y);
      const w = Math.abs(b.angularVelocity);
      const ok = (s < settleV && w < settleW && b.position.y < this.h - (this.cfg.GAME?.groundHeight ?? 110) - 10);

      const c = this.settleCounter.get(b.id) ?? 0;
      if (ok){
        const nc = c + 1;
        this.settleCounter.set(b.id, nc);
        if (nc >= need){
          this.scored.add(b.id);
          this.score += per;
          // Height bonus
          const hbEvery = this.cfg.SCORING?.heightBonusEveryPx ?? 180;
          const hbPts = this.cfg.SCORING?.heightBonusPoints ?? 5;
          const top = this.getTowerTopY();
          const height = Math.max(0, (this.h - (this.cfg.GAME?.groundHeight ?? 110)) - top);
          const bonus = Math.floor(height / hbEvery) * hbPts;
          this.score += bonus;
          this.onHud?.(this.score);
          this.playPop();
        }
      } else {
        if (c !== 0) this.settleCounter.set(b.id, 0);
      }
    }

    // clamp bodies count
    const maxBodies = this.cfg.GAME?.maxBodies ?? 120;
    if (animals.length > maxBodies){
      // remove oldest scored ones to reduce load
      const toRemove = animals
        .filter(b => this.scored.has(b.id))
        .sort((a,b)=> a.id - b.id)
        .slice(0, animals.length - maxBodies);
      for (const b of toRemove){
        World.remove(this.world, b);
      }
    }
  }

  getTowerTopY(){
    let top = this.h;
    const animals = Composite.allBodies(this.world).filter(b => b.label === 'animal');
    for (const b of animals){
      const y = b.bounds.min.y;
      if (y < top) top = y;
    }
    return top;
  }

  playPop(){
    if (!this.soundEnabled) return;
    // Minimal WebAudio pop (no external assets)
    try{
      const ac = this._ac || (this._ac = new (window.AudioContext || window.webkitAudioContext)());
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'triangle';
      o.frequency.value = 520 + Math.random()*120;
      g.gain.value = 0.0001;
      o.connect(g); g.connect(ac.destination);
      const t = ac.currentTime;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      o.start(t);
      o.stop(t + 0.10);
    }catch{}
  }

  gameOver(){
    if (!this.running) return;
    this.running = false;

    // Controls
    this.moveDir = 0; // -1 left, 0 none, 1 right

    this.lastScore = this.score;
    this.onGameOver?.(this.lastScore);
  }

  resize(){
    const prCap = this.cfg.SPRITES?.pixelRatioCap ?? 2.0;
    this.dpr = Math.min(prCap, window.devicePixelRatio || 1);
    const rectW = Math.floor(window.innerWidth);
    const rectH = Math.floor(window.innerHeight);
    this.canvas.width = Math.floor(rectW * this.dpr);
    this.canvas.height = Math.floor(rectH * this.dpr);
    this.canvas.style.width = rectW + 'px';
    this.canvas.style.height = rectH + 'px';
    this.w = rectW;
    this.h = rectH;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  render(){
    const ctx = this.ctx;
    ctx.clearRect(0,0,this.w,this.h);
    ctx.fillStyle = this.cfg.SPRITES?.backgroundColor ?? '#0b1020';
    ctx.fillRect(0,0,this.w,this.h);

    // subtle gradient
    const g = ctx.createLinearGradient(0,0,0,this.h);
    g.addColorStop(0, 'rgba(59,130,246,0.12)');
    g.addColorStop(1, 'rgba(236,72,153,0.04)');
    ctx.fillStyle = g;
    ctx.fillRect(0,0,this.w,this.h);

    // draw platform
    const gh = this.cfg.GAME?.groundHeight ?? 110;
    const xMin = this.platform?.xMin ?? 0;
    const xMax = this.platform?.xMax ?? this.w;
    ctx.fillStyle = 'rgba(0,0,0,0.20)';
    ctx.fillRect(xMin, this.h - gh, xMax - xMin, gh);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.moveTo(xMin, this.h - gh);
    ctx.lineTo(xMax, this.h - gh);
    ctx.stroke();

    // draw bodies (animals)
    const bodies = Composite.allBodies(this.world);
    for (const b of bodies){
      if (b.label !== 'animal') continue;
      this.drawSpriteBody(ctx, b);

      if (this.cfg.DEBUG?.drawAABB){
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.strokeRect(b.bounds.min.x, b.bounds.min.y, b.bounds.max.x - b.bounds.min.x, b.bounds.max.y - b.bounds.min.y);
      }
      if (this.cfg.DEBUG?.drawOutlines){
        this.drawBodyOutline(ctx, b);
      }
    }
  }

  drawSpriteBody(ctx, body){
    const spr = body.renderSprite;
    if (!spr?.img) return;
    const img = spr.img;
    const s = spr.scale ?? 1;

    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;

    ctx.save();
    ctx.translate(body.position.x, body.position.y);
    ctx.rotate(body.angle);
    ctx.drawImage(img, -w/2, -h/2, w, h);
    ctx.restore();
  }

  drawBodyOutline(ctx, body){
    if (!body.vertices?.length) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    const v0 = body.vertices[0];
    ctx.moveTo(v0.x, v0.y);
    for (let i=1;i<body.vertices.length;i++){
      const v = body.vertices[i];
      ctx.lineTo(v.x, v.y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
}

async function loadImage(src){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load failed: ' + src));
    img.src = src;
  });
}

function tryLoadVertices(key){
  try{
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length < 8) return null;
    // Validate shape
    if (!arr.every(p => typeof p.x === 'number' && typeof p.y === 'number')) return null;
    return arr;
  } catch {
    return null;
  }
}

function trySaveVertices(key, verts){
  try{
    localStorage.setItem(key, JSON.stringify(verts));
  } catch {}
}
