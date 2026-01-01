export async function loadJson(url){
  // cache-bust by appending ?v=timestamp when needed
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return await res.json();
}

export async function loadConfig(url){
  const cfg = await loadJson(url);
  return cfg;
}

export async function loadAssets(url){
  const assets = await loadJson(url);
  return assets;
}

export function preloadImages(urls){
  const uniq = [...new Set(urls)];
  return Promise.all(uniq.map(src => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ src, ok: true });
    img.onerror = () => resolve({ src, ok: false });
    img.src = src;
  })));
}
