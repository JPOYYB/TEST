(() => {
  const { MAX_DAYS, start, talkCases } = window.BAR_DATA;

  const S = {
    day: 1,
    gold: start.gold,
    rep: start.rep,
    fear: start.fear,
    sup: start.sup,
    cur: start.cur,
    phase: "choose" // choose | mini | after | end
  };

  const $ = (id) => document.getElementById(id);
  const ui = {
    day: $("day"),
    stat: $("stat"),
    phaseTxt: $("phaseTxt"),
    fearTxt: $("fearTxt"),
    supTxt: $("supTxt"),
    curTxt: $("curTxt"),
    fearFill: $("fearFill"),
    supFill: $("supFill"),
    curFill: $("curFill"),
    log: $("log"),

    aCook: $("aCook"),
    aTalk: $("aTalk"),
    aSupply: $("aSupply"),
    skip: $("skip"),
    nextDay: $("nextDay"),
    reset: $("reset"),

    miniTitle: $("miniTitle"),
    miniDesc: $("miniDesc"),
    miniBody: $("miniBody"),
  };

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const pct = (v) => `${clamp(v, 0, 100)}%`;
  const stamp = () => {
    const t = new Date();
    return `${String(t.getHours()).padStart(2,"0")}:${String(t.getMinutes()).padStart(2,"0")}:${String(t.getSeconds()).padStart(2,"0")}`;
  };
  const log = (m) => { ui.log.textContent = `[${stamp()}] ${m}\n` + ui.log.textContent; };

  function render() {
    ui.day.textContent = S.day;
    ui.stat.textContent = `${S.gold} / ${S.rep}`;
    ui.phaseTxt.textContent = S.phase === "choose" ? "行動選択" : S.phase === "after" ? "結果確認" : "進行終了";

    ui.fearTxt.textContent = S.fear;
    ui.supTxt.textContent  = S.sup;
    ui.curTxt.textContent  = S.cur;

    ui.fearFill.style.width = pct(S.fear);
    ui.supFill.style.width  = pct(S.sup);
    ui.curFill.style.width  = pct(S.cur);

    const canChoose = (S.phase === "choose");
    ui.aCook.disabled = !canChoose;
    ui.aTalk.disabled = !canChoose;
    ui.aSupply.disabled = !canChoose;
    ui.skip.disabled = !canChoose;

    ui.nextDay.style.display = (S.phase === "after") ? "block" : "none";
  }

  function winCheck() {
    if (S.fear <= 0 && S.sup <= 0 && S.cur <= 0) {
      S.phase = "end";
      ui.miniTitle.textContent = "勝利：魔王、成立不能。";
      ui.miniDesc.textContent = "あなたは“勇者ムーブ”を避けた。だから勝った。";
      ui.miniBody.innerHTML = `<div class="muted">恐怖・兵站・呪いが全部0。魔王は支配の柱を失って崩壊。</div>`;
      log("=== 勝利：魔王の支配システムが破綻 ===");
      render();
      return true;
    }
    if (S.day > MAX_DAYS) {
      S.phase = "end";
      ui.miniTitle.textContent = "敗北：日数切れ。";
      ui.miniDesc.textContent = "プロトなのでバランスは雑。削り幅 or 日数を調整すると一気に良くなる。";
      ui.miniBody.innerHTML = `<div class="muted">次は“各ミニゲームの削り幅”を揃えて手触りを作る。</div>`;
      log("=== 敗北：日数切れ ===");
      render();
      return true;
    }
    return false;
  }

  function endAction(summaryHtml) {
    S.phase = "after";
    ui.miniTitle.textContent = "結果";
    ui.miniDesc.textContent = "確認して「次の日へ」。";
    ui.miniBody.innerHTML = summaryHtml;
    render();
    winCheck();
  }

  function nextDay() {
    if (S.phase !== "after") return;
    S.day += 1;
    if (winCheck()) return;

    S.phase = "choose";
    ui.miniTitle.textContent = "今日の行動を選べ";
    ui.miniDesc.textContent = "行動を1つ実行すると「次の日へ」が押せます。";
    ui.miniBody.innerHTML = `<div class="muted">（🍢/🗣/📦 のどれか1つ）</div>`;
    log(`--- Day ${S.day} 開始 ---`);
    render();
  }

  // ===== Mini 1: Cook (STOP timing) =====
  let cookPos = 0, cookDir = 1, cookTimer = null;

  function startCook() {
    S.phase = "mini";
    ui.miniTitle.textContent = "仕込み：STOPでタイミング";
    ui.miniDesc.textContent = "バーが中央(緑ゾーン)に来た瞬間にSTOP。";
    ui.miniBody.innerHTML = `
      <div class="bar" style="height:16px;position:relative;">
        <div class="fill" id="cookFill" style="width:0%"></div>
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;">
          <div style="width:18%;height:8px;background:#2a6;border-radius:999px;opacity:.9;"></div>
        </div>
      </div>
      <div class="btns" style="margin-top:10px;">
        <button id="cookStop"><span class="kbd">STOP</span></button>
      </div>
      <div class="muted" style="margin-top:6px;">成功：呪い -18 / 失敗：呪い -6</div>
    `;
    render();

    const cookFill = document.getElementById("cookFill");
    const btn = document.getElementById("cookStop");

    cookPos = 0; cookDir = 1;
    if (cookTimer) clearInterval(cookTimer);
    cookTimer = setInterval(() => {
      cookPos += cookDir * (Math.random() * 3 + 2);
      if (cookPos >= 100) { cookPos = 100; cookDir = -1; }
      if (cookPos <= 0)   { cookPos = 0;   cookDir =  1; }
      cookFill.style.width = cookPos + "%";
    }, 60);

    btn.onclick = () => {
      if (cookTimer) { clearInterval(cookTimer); cookTimer = null; }
      const inGreen = (cookPos >= 41 && cookPos <= 59);
      const down = inGreen ? 18 : 6;
      const goldUp = inGreen ? 12 : 5;
      const repUp = inGreen ? 2 : 0;

      S.cur = clamp(S.cur - down, 0, 100);
      S.gold += goldUp;
      S.rep += repUp;

      log(`仕込み：${inGreen ? "神" : "凡"} → 呪い -${down}, Gold +${goldUp}${repUp ? `, Rep +${repUp}` : ""}`);
      endAction(`<div class="muted">仕込み完了。呪いが弱体化（-${down}）。</div>`);
    };
  }

  // ===== Mini 2: Talk (3 choices) =====
  function startTalk() {
    S.phase = "mini";
    const pick = talkCases[Math.floor(Math.random() * talkCases.length)];
    ui.miniTitle.textContent = "接客：一言で空気を変える";
    ui.miniDesc.textContent = "正解を選ぶと恐怖を大きく削る。";
    ui.miniBody.innerHTML = `
      <div class="big">${pick.p}</div>
      <div class="btns" style="margin-top:10px;">
        <button id="TA">A：${pick.A}</button>
        <button id="TB">B：${pick.B}</button>
        <button id="TC">C：${pick.C}</button>
      </div>
      <div class="muted">成功：恐怖 -18 / 失敗：恐怖 -6</div>
    `;
    render();

    const resolve = (choice) => {
      const ok = (choice === pick.c);
      const down = ok ? 18 : 6;
      const goldUp = ok ? 6 : 3;
      const repUp = ok ? 3 : 0;

      S.fear = clamp(S.fear - down, 0, 100);
      S.gold += goldUp;
      S.rep += repUp;

      log(`接客：${ok ? "命中" : "空振り"} → 恐怖 -${down}, Gold +${goldUp}${repUp ? `, Rep +${repUp}` : ""}`);
      endAction(`<div class="muted">接客で街の空気が変わった。恐怖が弱体化（-${down}）。</div>`);
    };

    document.getElementById("TA").onclick = () => resolve("A");
    document.getElementById("TB").onclick = () => resolve("B");
    document.getElementById("TC").onclick = () => resolve("C");
  }

  // ===== Mini 3: Supply (NO luck) Route Optimization =====
  // 6列 × 4行の“闇税”グリッド（数字が小さいほど良い）
  // ルール：左→右へ1列ずつ進む。各列で1マス選ぶ（隣の行へは±1まで移動可）。
  // 目的：合計闇税を小さくする（＝兵站に大ダメージ）
  function seededRand(seed) {
    // 超簡易LCG（毎日同じ盤面にしたい時のため）
    let x = seed >>> 0;
    return () => (x = (1664525 * x + 1013904223) >>> 0) / 4294967296;
  }

  function startSupply() {
    S.phase = "mini";
    ui.miniTitle.textContent = "仕入れ：ルート最適化（運なし）";
    ui.miniDesc.textContent = "各列で1マス選び、右へ進むルートの闇税合計を最小化。";
    ui.miniBody.innerHTML = `
      <div class="muted">
        ルール：左→右へ1列ずつ。次の列では行移動は <b>±1</b> まで。<br/>
        6列すべて選ぶと確定（闇税が小さいほど、兵站が大きく削れる）。
      </div>
      <div id="grid" class="grid"></div>
      <div class="row" style="margin-top:10px;">
        <div class="pill"><span>選択列</span><span id="colTxt">1 / 6</span></div>
        <div class="pill"><span>闇税合計</span><span id="taxTxt">0</span></div>
        <div class="pill"><span>移動制約</span><span id="ruleTxt">最初は自由</span></div>
      </div>
      <div class="btns" style="margin-top:10px;">
        <button id="undo">1手戻す</button>
        <button id="commit" class="good" disabled>確定</button>
      </div>
    `;
    render();

    const rng = seededRand(1000 + S.day); // Day依存：運ではなく「毎日盤面が変わる」だけ
    const rows = 4, cols = 6;
    const grid = [];
    for (let r=0;r<rows;r++){
      const line=[];
      for (let c=0;c<cols;c++){
        // 0〜9：見えているので“運”ではなく“解く”
        line.push(Math.floor(rng()*10));
      }
      grid.push(line);
    }

    const gridEl = document.getElementById("grid");
    const colTxt = document.getElementById("colTxt");
    const taxTxt = document.getElementById("taxTxt");
    const ruleTxt = document.getElementById("ruleTxt");
    const btnUndo = document.getElementById("undo");
    const btnCommit = document.getElementById("commit");

    let picks = []; // {r,c,val}
    let curCol = 0;

    function allowedRow(r) {
      if (picks.length === 0) return true;
      const prev = picks[picks.length - 1].r;
      return Math.abs(r - prev) <= 1;
    }

    function sumTax() {
      return picks.reduce((a,p)=>a+p.val,0);
    }

    function redraw() {
      gridEl.innerHTML = "";
      for (let r=0;r<rows;r++){
        for (let c=0;c<cols;c++){
          const val = grid[r][c];
          const d = document.createElement("div");
          d.className = "cell";
          d.textContent = String(val);
          const sm = document.createElement("small");
          sm.textContent = `R${r+1} C${c+1}`;
          d.appendChild(sm);

          const picked = picks.find(p => p.r===r && p.c===c);
          if (picked) d.classList.add("pick");

          const isCurrentColumn = (c === curCol);
          if (!isCurrentColumn) d.style.opacity = "0.55";

          // 現在列で、移動制約に違反する行は “選べない” を見せる
          if (isCurrentColumn && !allowedRow(r)) {
            d.classList.add("bad");
            d.style.opacity = "0.35";
          }

          d.onclick = () => {
            if (c !== curCol) return;
            if (!allowedRow(r)) return;

            picks.push({ r, c, val });
            curCol++;
            colTxt.textContent = `${curCol+0} / ${cols}`; // いま選んだ列数
            taxTxt.textContent = String(sumTax());
            ruleTxt.textContent = (picks.length===0) ? "最初は自由" : `次は行 ${picks[picks.length-1].r+1} の上下±1`;
            btnCommit.disabled = (picks.length !== cols);
            redraw();
          };
          gridEl.appendChild(d);
        }
      }
      colTxt.textContent = `${Math.min(picks.length+1, cols)} / ${cols}`;
      taxTxt.textContent = String(sumTax());
      ruleTxt.textContent = (picks.length===0) ? "最初は自由" : `次は行 ${picks[picks.length-1].r+1} の上下±1`;
      btnCommit.disabled = (picks.length !== cols);
    }

    btnUndo.onclick = () => {
      if (picks.length === 0) return;
      picks.pop();
      curCol = picks.length;
      redraw();
    };

    btnCommit.onclick = () => {
      if (picks.length !== cols) return;
      const tax = sumTax(); // 小さいほど良い

      // tax 0〜54想定。小さいほど削り大。
      // 例：tax=12 → 20 - 3.6 ≒ 16、tax=40 → 20 - 12 = 8
      const supDown = clamp(Math.round(20 - tax * 0.3), 6, 20);

      // コストは“闇税回避のための正規ルート整備費”として tax に比例（痛みのある改革）
      const cost = clamp(Math.round(tax * 0.15), 0, 12);

      S.sup = clamp(S.sup - supDown, 0, 100);
      S.gold = clamp(S.gold - cost, 0, 999);
      S.rep += (tax <= 18) ? 2 : 0;

      log(`仕入れ：闇税${tax} → 兵站 -${supDown}, Gold -${cost}${tax<=18?`, Rep +2`:""}`);
      endAction(`<div class="muted">ルート確定。闇税合計 <b>${tax}</b> → 兵站（-${supDown}）。</div>`);
    };

    redraw();
  }

  // ===== Buttons =====
  ui.aCook.onclick = () => { if (S.phase === "choose") startCook(); };
  ui.aTalk.onclick = () => { if (S.phase === "choose") startTalk(); };
  ui.aSupply.onclick = () => { if (S.phase === "choose") startSupply(); };

  ui.skip.onclick = () => {
    if (S.phase !== "choose") return;
    S.fear = clamp(S.fear + 4, 0, 100);
    S.sup  = clamp(S.sup  + 4, 0, 100);
    S.cur  = clamp(S.cur  + 4, 0, 100);
    log("閉店：世界は勝手に悪化（恐怖/兵站/呪い 各+4）");
    endAction(`<div class="muted">閉店した。魔王の支配が少し戻った（各+4）。</div>`);
  };

  ui.nextDay.onclick = () => nextDay();

  ui.reset.onclick = () => {
    S.day = 1;
    S.gold = start.gold;
    S.rep = start.rep;
    S.fear = start.fear;
    S.sup  = start.sup;
    S.cur  = start.cur;
    S.phase = "choose";

    ui.log.textContent = "";
    ui.miniTitle.textContent = "今日の行動を選べ";
    ui.miniDesc.textContent = "行動を1つ実行すると「次の日へ」が押せます。";
    ui.miniBody.innerHTML = `<div class="muted">（🍢/🗣/📦 のどれか1つ）</div>`;
    log("--- リセット ---");
    render();
  };

  // init
  log("--- Day 1 開始 ---");
  ui.miniBody.innerHTML = `<div class="muted">（🍢/🗣/📦 のどれか1つ）</div>`;
  render();
})();
