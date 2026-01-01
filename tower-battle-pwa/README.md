# タワーバトル（スマホ用HTML）
このフォルダをそのまま静的サーバで配信すると遊べます。

## 画像を置く場所（あなたが用意）
- 動物PNG: `assets/animals/1.png` ～ `10.png`（透過PNG）
- タイトルロゴ: `assets/ui/title_logo.png`（透過推奨）
- タイトル背景: `assets/ui/title_bg.png`（背景PNG。透過でもOK）

## 推奨サイズ
- 動物: 512x512 〜 768x768（同一サイズ推奨。余白ありでOK）
- title_logo: 横長（例 1024x256〜512）
- title_bg: 縦長（例 1080x1920）

## 設定を変える
- `config/config.json` を編集（ゲーム時間、物理、スコアなど）
- `config/assets.json` を編集（動物の追加/差し替え）

## 起動（例）
Python:
  python -m http.server 8000
→ http://localhost:8000


## GitHub Pages で公開する（推奨）
1. このフォルダをリポジトリに push
2. GitHub → Settings → Pages
3. Branch を `main` / folder を `/ (root)` にして Save
4. 数十秒後にURLが出ます（HTTPSでPWA動作）

※ PWA（ホーム画面追加）は、https で配信される環境（GitHub Pages等）で動きます。
