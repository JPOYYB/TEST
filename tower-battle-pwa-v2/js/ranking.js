export class Leaderboard{
  constructor(cfg){
    this.cfg = cfg;
    this.key = `towerbattle_lb_v${cfg.VERSION ?? 1}`;
  }

  get(){
    try{
      const raw = localStorage.getItem(this.key);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  save(arr){
    localStorage.setItem(this.key, JSON.stringify(arr));
  }

  getBestScore(){
    const arr = this.get();
    return arr.length ? arr[0].score : 0;
  }

  qualifies(score){
    const max = this.cfg.RANKING?.maxEntries ?? 10;
    const arr = this.get();
    if (arr.length < max) return score > 0;
    return score > (arr[arr.length - 1]?.score ?? 0);
  }

  sanitizeName(name){
    const maxLen = this.cfg.RANKING?.nameMaxLen ?? 12;
    let s = String(name).trim().slice(0, maxLen);
    if (!s) s = 'NoName';
    // Replace problematic words (very simple)
    const bad = this.cfg.RANKING?.badWords ?? [];
    for (const w of bad){
      if (!w) continue;
      const re = new RegExp(escapeRegExp(w), 'ig');
      s = s.replace(re, (m) => '＊'.repeat(Math.min(6, m.length)));
    }
    return s;
  }

  add(entry){
    const max = this.cfg.RANKING?.maxEntries ?? 10;
    const arr = this.get();
    arr.push({
      name: this.sanitizeName(entry.name),
      score: Number(entry.score) || 0,
      t: Date.now()
    });
    arr.sort((a,b) => b.score - a.score || a.t - b.t);
    this.save(arr.slice(0, max));
  }
}

function escapeRegExp(s){
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
