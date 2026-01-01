import { loadConfig, loadAssets, preloadImages } from './loader.js';
import { Leaderboard } from './ranking.js';
import { TowerBattle } from './towerbattle.js';

const $ = (sel) => document.querySelector(sel);

const screens = {
  title: $('#screen-title'),
  howto: $('#screen-howto'),
  result: $('#screen-result'),
  ranking: $('#screen-ranking'),
  name: $('#screen-name'),
};

function showScreen(key){
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[key].classList.add('active');
}

function setHudVisible(v){
  $('#hud').classList.toggle('hidden', !v);
  $('#controls').classList.toggle('hidden', !v);
  // time is not used (no timer); keep chip but do not update
}

function setTitleImages(cfg){
  const bg = cfg.ASSET_PATHS?.titleBg;
  const logo = cfg.ASSET_PATHS?.titleLogo;
  if (bg){
    $('#title-bg').style.backgroundImage = `url(${bg})`;
    $('#title-bg').style.backgroundSize = 'cover';
    $('#title-bg').style.backgroundPosition = 'center';
    $('#title-bg').style.opacity = '1';
  }
  if (logo){
    $('#title-logo').src = logo;
  } else {
    $('#title-logo').style.display = 'none';
  }
}

(async function boot(){
  const cfg = await loadConfig('config/config.json');
  const assets = await loadAssets('config/assets.json');

  setTitleImages(cfg);

  // Preload images (animals + title)
  const preloadList = [
    ...(assets.animals?.map(a => a.src) ?? []),
    cfg.ASSET_PATHS?.titleLogo,
    cfg.ASSET_PATHS?.titleBg,
  ].filter(Boolean);
  await preloadImages(preloadList);

  const leaderboard = new Leaderboard(cfg);
  const game = new TowerBattle({
    cfg,
    assets,
    canvas: $('#game'),
    onHud: (score) => {
      $('#hud-score').textContent = String(score);
      // no timer
      // $('#hud-time').textContent = String(timeLeft);
    },
    onGameOver: (score) => {
      setHudVisible(false);
      $('#result-score').textContent = `Score: ${score}`;
      $('#result-best').textContent = `Best: ${leaderboard.getBestScore()}`;
      // Enable submit only if qualifies (or empty list)
      $('#btn-submit').disabled = !leaderboard.qualifies(score);
      showScreen('result');
    }
  });


  // Controls (hold to move, tap to drop)
  const btnLeft = $('#btn-left');
  const btnRight = $('#btn-right');
  const btnDrop = $('#btn-drop');

  const hold = (el, dir) => {
    const down = (e) => { e.preventDefault(); game.setMoveDir(dir); };
    const up = (e) => { e.preventDefault(); game.setMoveDir(0); };
    el.addEventListener('pointerdown', down, { passive:false });
    el.addEventListener('pointerup', up, { passive:false });
    el.addEventListener('pointercancel', up, { passive:false });
    el.addEventListener('pointerleave', up, { passive:false });
  };
  hold(btnLeft, -1);
  hold(btnRight, 1);
  btnDrop.addEventListener('pointerdown', (e) => { e.preventDefault(); game.drop(); }, { passive:false });

  // UI handlers
  $('#btn-start').addEventListener('click', () => {
    showScreen('title'); // keep overlay visible until game starts
    showScreen('title'); // no-op; just explicit
    setHudVisible(true);
    game.start();
    // hide overlay (title screen)
    Object.values(screens).forEach(s => s.classList.remove('active'));
    $('#overlay').style.pointerEvents = 'none';
  });

  $('#btn-howto').addEventListener('click', () => showScreen('howto'));
  $('#btn-ranking').addEventListener('click', () => {
    renderRanking(leaderboard);
    showScreen('ranking');
  });

  // Sound toggle (logic is in cfg + game; kept minimal)
  let soundOn = !!cfg.SOUND?.enabledByDefault;
  $('#btn-sound').textContent = `サウンド：${soundOn ? 'ON' : 'OFF'}`;
  $('#btn-sound').addEventListener('click', () => {
    soundOn = !soundOn;
    $('#btn-sound').textContent = `サウンド：${soundOn ? 'ON' : 'OFF'}`;
    game.setSoundEnabled(soundOn);
  });

  // nav buttons
  document.body.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('[data-nav]');
    if (!btn) return;
    const key = btn.getAttribute('data-nav');
    if (key === 'title'){
      $('#overlay').style.pointerEvents = 'auto';
      showScreen('title');
    } else if (key === 'ranking'){
      renderRanking(leaderboard);
      showScreen('ranking');
    }
  });

  $('#btn-retry').addEventListener('click', () => {
    $('#overlay').style.pointerEvents = 'none';
    setHudVisible(true);
    game.start();
  });

  // submit name
  $('#btn-submit').addEventListener('click', () => {
    $('#name-input').value = '';
    showScreen('name');
  });
  $('#btn-name-cancel').addEventListener('click', () => showScreen('result'));
  $('#btn-name-ok').addEventListener('click', () => {
    const raw = $('#name-input').value || 'NoName';
    const safe = leaderboard.sanitizeName(raw);
    const score = game.getLastScore();
    leaderboard.add({ name: safe, score });
    renderRanking(leaderboard);
    showScreen('ranking');
  });

  function renderRanking(lb){
    const list = $('#ranking-list');
    const items = lb.get();
    if (!items.length){
      list.innerHTML = '<p class="fineprint">まだ登録がありません。最初の塔を建てよう。</p>';
      return;
    }
    list.innerHTML = items.map((r, i) => `
      <div class="rank-row">
        <div class="rank-left">
          <div class="rank-no">${i+1}</div>
          <div class="rank-name">${escapeHtml(r.name)}</div>
        </div>
        <div class="rank-score">${r.score}</div>
      </div>
    `).join('');
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // Initial state
  showScreen('title');
  setHudVisible(false);
})();
