'use strict';
(() => {
// =====================================================================
//  ユーティリティ
// =====================================================================
const $ = (sel) => document.querySelector(sel);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const DEG = Math.PI / 180;
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
};
const isEditable = (t) => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

// =====================================================================
//  状態
// =====================================================================
const state = {
  canvas: { w: 1280, h: 720, bg: 'transparent', bgColor: '#ffffff' },
  layers: [],          // 末尾が最前面
  selectedId: null,
};
const view = { zoom: 1, panX: 0, panY: 0, dpr: window.devicePixelRatio || 1 };
const grid = { on: false, size: 32, snap: true };   // グリッド表示と吸着（設定は localStorage に保存）
try { Object.assign(grid, JSON.parse(localStorage.getItem('browser-img-edit.grid') || '{}')); } catch (e) { /* ignore */ }
const images = new Map();   // imgId -> HTMLImageElement | HTMLCanvasElement（履歴のJSONには含めない）
const imageBlobs = new Map(); // imgId -> Blob（元ファイル。プロジェクト保存で再エンコードせずに使う）
let nextId = 1;
const uid = () => 'L' + (nextId++);
let mode = null;            // null | { kind:'layerCrop'|'canvasCrop', layerId?, rect? }
let drag = null;            // ポインタ操作中の状態
let spaceDown = false;

const BLENDS = [
  ['source-over', '通常'], ['multiply', '乗算'], ['screen', 'スクリーン'], ['overlay', 'オーバーレイ'],
  ['darken', '比較（暗）'], ['lighten', '比較（明）'], ['color-dodge', '覆い焼き'], ['color-burn', '焼き込み'],
  ['hard-light', 'ハードライト'], ['soft-light', 'ソフトライト'], ['difference', '差の絶対値'], ['exclusion', '除外'],
  ['hue', '色相'], ['saturation', '彩度'], ['color', 'カラー'], ['luminosity', '輝度'],
];
const FONTS = ['sans-serif', 'serif', 'monospace', 'Meiryo', 'Yu Gothic', 'Yu Mincho', 'MS Gothic', 'MS Mincho',
  'Arial', 'Arial Black', 'Impact', 'Verdana', 'Georgia', 'Times New Roman', 'Courier New', 'Comic Sans MS'];

const defaultFilters = () => ({ brightness: 100, contrast: 100, saturate: 100, blur: 0, grayscale: 0, sepia: 0, hueRotate: 0, invert: 0 });

function baseLayer(type, name) {
  return {
    id: uid(), type, name, x: 0, y: 0, w: 100, h: 100, rotation: 0,
    flipX: false, flipY: false, opacity: 1, visible: true, locked: false,
    blend: 'source-over', filters: defaultFilters(),
  };
}
function makeImageLayer(img, name, blob = null) {
  const l = baseLayer('image', name);
  l.imgId = l.id;
  images.set(l.imgId, img);
  if (blob) imageBlobs.set(l.imgId, blob);
  l.w = img.naturalWidth; l.h = img.naturalHeight;
  l.crop = { sx: 0, sy: 0, sw: img.naturalWidth, sh: img.naturalHeight };
  return l;
}
function makeTextLayer() {
  const l = baseLayer('text', 'テキスト');
  Object.assign(l, {
    text: 'テキスト', fontFamily: 'sans-serif', fontSize: 64, color: '#ffffff', bold: true, italic: false,
    align: 'left', strokeColor: '#000000', strokeWidth: 0, lineHeight: 1.2, natW: 1, natH: 1,
  });
  measureText(l); l.w = l.natW; l.h = l.natH;
  return l;
}
function makeShapeLayer(kind) {
  const names = { rect: '矩形', ellipse: '楕円', line: '線' };
  const l = baseLayer('shape', names[kind]);
  Object.assign(l, { kind, fillOn: kind !== 'line', fill: '#3b82f6', stroke: '#ffffff', strokeWidth: kind === 'line' ? 6 : 0, radius: 0 });
  l.w = kind === 'line' ? 300 : 200; l.h = kind === 'line' ? 24 : 200;
  return l;
}
// 描画レイヤー: キャンバスと同じ大きさのビットマップを持つ。内容は images に、履歴には rev 番号だけを持ち paintRevs で復元する
function makePaintLayer(w = state.canvas.w, h = state.canvas.h) {
  const l = baseLayer('paint', '描画');
  const cv = document.createElement('canvas'); cv.width = Math.max(1, w); cv.height = Math.max(1, h);
  l.imgId = l.id; l.rev = 0;
  images.set(l.imgId, cv);
  savePaintRev(l.imgId, 0, cv);
  l.w = cv.width; l.h = cv.height;
  return l;
}

// ---------- テキスト計測 ----------
const measureCtx = document.createElement('canvas').getContext('2d');
const textFont = (l) => `${l.italic ? 'italic ' : ''}${l.bold ? 'bold ' : ''}${l.fontSize}px ${l.fontFamily}`;
const textLines = (l) => (l.text === '' ? ' ' : l.text).split('\n');
function measureText(l) {
  measureCtx.font = textFont(l);
  let w = 0;
  for (const s of textLines(l)) w = Math.max(w, measureCtx.measureText(s).width);
  const pad = l.strokeWidth;
  l.natW = Math.max(1, Math.ceil(w + pad * 2));
  l.natH = Math.max(1, Math.ceil(textLines(l).length * l.fontSize * l.lineHeight + pad * 2));
}
// 内容/フォント変更後: 現在の拡大率を保ったまま自然サイズを更新
function retext(l) {
  const sx = l.w / l.natW, sy = l.h / l.natH;
  measureText(l);
  l.w = l.natW * sx; l.h = l.natH * sy;
}

// =====================================================================
//  履歴（Undo / Redo）
// =====================================================================
const history = { stack: [], idx: -1, MAX: 50 };
const snapshot = () => JSON.stringify({ canvas: state.canvas, layers: state.layers });
function commit() {
  history.stack.length = history.idx + 1;
  history.stack.push(snapshot());
  if (history.stack.length > history.MAX) history.stack.shift();
  history.idx = history.stack.length - 1;
  prunePaintRevs();
  scheduleAutosave();
  refresh();
}
function restore(json) {
  const s = JSON.parse(json);
  state.canvas = s.canvas; state.layers = s.layers;
  if (!getLayer(state.selectedId)) state.selectedId = null;
  exitMode(false);
  syncPaintRevs();
  scheduleAutosave();
  refresh();
}

// ---------- 描画レイヤーのビットマップ履歴 ----------
// imgId -> Map(rev -> Promise<Blob>)。PNG 圧縮して保持する（透明が多い描画レイヤーは小さくなる）
const paintRevs = new Map();
const canvasToBlob = (cv, type = 'image/png', q) => new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), type, q));
function savePaintRev(imgId, rev, cv) {
  if (!paintRevs.has(imgId)) paintRevs.set(imgId, new Map());
  cv._rev = rev;
  paintRevs.get(imgId).set(rev, canvasToBlob(cv));
}
// undo/redo 後: 各描画レイヤーのビットマップを l.rev の内容に戻す（非同期。戻り次第再描画）
function syncPaintRevs() {
  for (const l of state.layers) {
    if (l.type !== 'paint') continue;
    const cv = images.get(l.imgId);
    if (!cv) continue;
    if (cv._rev === l.rev) { cv._want = l.rev; continue; }   // 読み込み中の古い要求を無効化
    const p = paintRevs.get(l.imgId) && paintRevs.get(l.imgId).get(l.rev);
    if (!p) continue;
    cv._want = l.rev;
    p.then((blob) => createImageBitmap(blob)).then((bmp) => {
      if (cv._want !== l.rev) return;
      cv.width = bmp.width; cv.height = bmp.height;
      cv.getContext('2d').drawImage(bmp, 0, 0);
      cv._rev = l.rev; bmp.close();
      refresh();
    }).catch((err) => console.error('描画履歴の復元に失敗:', err));
  }
}
// 履歴のどこからも参照されなくなった rev / 画像を破棄する
function prunePaintRevs() {
  const used = new Map();   // imgId -> Set(rev)
  const mark = (layers) => { for (const l of layers) if (l.imgId) { if (!used.has(l.imgId)) used.set(l.imgId, new Set()); if (l.type === 'paint') used.get(l.imgId).add(l.rev); } };
  for (const json of history.stack) mark(JSON.parse(json).layers);
  mark(state.layers);
  for (const [id, revs] of paintRevs) {
    const u = used.get(id);
    if (!u) { paintRevs.delete(id); continue; }
    for (const r of [...revs.keys()]) if (!u.has(r)) revs.delete(r);
  }
  for (const id of [...images.keys()]) if (!used.has(id)) { images.delete(id); imageBlobs.delete(id); }
}
function undo() { if (history.idx > 0) { history.idx--; restore(history.stack[history.idx]); } }
function redo() { if (history.idx < history.stack.length - 1) { history.idx++; restore(history.stack[history.idx]); } }

// =====================================================================
//  レイヤー操作
// =====================================================================
const getLayer = (id) => state.layers.find((l) => l.id === id) || null;
const selected = () => getLayer(state.selectedId);
const layerIndex = (id) => state.layers.findIndex((l) => l.id === id);

function select(id) {
  if (state.selectedId === id) return;
  state.selectedId = id;
  if (mode) exitMode(false);
  refresh();
}
function addLayer(l, { center = true } = {}) {
  if (center) { l.x = Math.round((state.canvas.w - l.w) / 2); l.y = Math.round((state.canvas.h - l.h) / 2); }
  state.layers.push(l);
  state.selectedId = l.id;
}
function deleteSelected() {
  const i = layerIndex(state.selectedId);
  if (i < 0) return;
  state.layers.splice(i, 1);
  const next = state.layers[Math.min(i, state.layers.length - 1)];
  state.selectedId = next ? next.id : null;
  commit();
}
function duplicateSelected() {
  const l = selected(); if (!l) return;
  const c = JSON.parse(JSON.stringify(l));
  c.id = uid(); c.name = l.name + ' コピー'; c.x += 20; c.y += 20;
  if (l.type === 'paint') {
    const src = images.get(l.imgId), cv = document.createElement('canvas');
    cv.width = src.width; cv.height = src.height; cv.getContext('2d').drawImage(src, 0, 0);
    c.imgId = c.id; c.rev = 0; images.set(c.imgId, cv); savePaintRev(c.imgId, 0, cv);
  }
  state.layers.splice(layerIndex(l.id) + 1, 0, c);
  state.selectedId = c.id;
  commit();
}
function moveLayer(id, to) {
  const from = layerIndex(id); if (from < 0) return;
  to = clamp(to, 0, state.layers.length - 1);
  if (from === to) return;
  const [l] = state.layers.splice(from, 1);
  state.layers.splice(to, 0, l);
  commit();
}

// ローカル座標（レイヤー中心が原点、回転前）とキャンバス座標の変換
function localToCanvas(l, lx, ly) {
  const c = Math.cos(l.rotation * DEG), s = Math.sin(l.rotation * DEG);
  return { x: l.x + l.w / 2 + lx * c - ly * s, y: l.y + l.h / 2 + lx * s + ly * c };
}
function canvasToLocal(l, p) {
  const c = Math.cos(-l.rotation * DEG), s = Math.sin(-l.rotation * DEG);
  const dx = p.x - (l.x + l.w / 2), dy = p.y - (l.y + l.h / 2);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}
const layerCorners = (l) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => localToCanvas(l, sx * l.w / 2, sy * l.h / 2));
function layerBBox(l) {
  const pts = layerCorners(l);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
function hitLayer(p) {
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const l = state.layers[i];
    if (!l.visible) continue;
    const q = canvasToLocal(l, p);
    if (Math.abs(q.x) <= l.w / 2 && Math.abs(q.y) <= l.h / 2) {
      if (l.type === 'paint' && !paintHit(l, p)) continue;   // 描画レイヤーは透明部分を素通し
      return l;
    }
  }
  return null;
}
function paintHit(l, p) {
  const cv = images.get(l.imgId); if (!cv) return false;
  const b = toBitmap(l, p);
  const x = Math.floor(b.x), y = Math.floor(b.y);
  if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) return false;
  return cv.getContext('2d').getImageData(x, y, 1, 1).data[3] > 8;
}

// =====================================================================
//  描画
// =====================================================================
function filterString(f) {
  const p = [];
  if (f.brightness !== 100) p.push(`brightness(${f.brightness}%)`);
  if (f.contrast !== 100) p.push(`contrast(${f.contrast}%)`);
  if (f.saturate !== 100) p.push(`saturate(${f.saturate}%)`);
  if (f.blur > 0) p.push(`blur(${f.blur}px)`);
  if (f.grayscale > 0) p.push(`grayscale(${f.grayscale}%)`);
  if (f.sepia > 0) p.push(`sepia(${f.sepia}%)`);
  if (f.hueRotate !== 0) p.push(`hue-rotate(${f.hueRotate}deg)`);
  if (f.invert > 0) p.push(`invert(${f.invert}%)`);
  return p.length ? p.join(' ') : 'none';
}
// 表示・書き出し共通の合成処理
function renderScene(ctx, topId = null) {
  for (const l of state.layers) if (l.visible && l.id !== topId) renderLayer(ctx, l);
  const top = topId && getLayer(topId);
  if (top && top.visible) renderLayer(ctx, top);
}
function renderLayer(ctx, l) {
  ctx.save();
  ctx.translate(l.x + l.w / 2, l.y + l.h / 2);
  ctx.rotate(l.rotation * DEG);
  ctx.scale(l.flipX ? -1 : 1, l.flipY ? -1 : 1);
  ctx.globalAlpha = l.opacity;
  ctx.globalCompositeOperation = l.blend;
  const f = filterString(l.filters);
  if (f !== 'none') ctx.filter = f;
  drawLayerContent(ctx, l);
  ctx.restore();
}
// レイヤー中心を原点とした座標系で内容を描く
function drawLayerContent(ctx, l) {
  const w = l.w, h = l.h;
  if (l.type === 'image') {
    const img = images.get(l.imgId); if (!img) return;
    const c = l.crop;
    ctx.drawImage(img, c.sx, c.sy, c.sw, c.sh, -w / 2, -h / 2, w, h);
  } else if (l.type === 'text') {
    ctx.scale(w / l.natW, h / l.natH);
    ctx.translate(-l.natW / 2, -l.natH / 2);
    ctx.font = textFont(l); ctx.textBaseline = 'top'; ctx.textAlign = l.align; ctx.lineJoin = 'round';
    const pad = l.strokeWidth, lh = l.fontSize * l.lineHeight;
    const ax = l.align === 'left' ? pad : l.align === 'center' ? l.natW / 2 : l.natW - pad;
    textLines(l).forEach((s, i) => {
      const y = pad + i * lh;
      if (l.strokeWidth > 0) { ctx.strokeStyle = l.strokeColor; ctx.lineWidth = l.strokeWidth * 2; ctx.strokeText(s, ax, y); }
      ctx.fillStyle = l.color; ctx.fillText(s, ax, y);
    });
  } else if (l.type === 'paint') {
    const src = (stroke && stroke.layerId === l.id) ? stroke.preview : images.get(l.imgId);
    if (src) ctx.drawImage(src, -w / 2, -h / 2, w, h);
  } else if (l.type === 'shape') {
    ctx.lineWidth = l.strokeWidth; ctx.strokeStyle = l.stroke; ctx.fillStyle = l.fill;
    ctx.beginPath();
    if (l.kind === 'rect') {
      if (l.radius > 0 && ctx.roundRect) ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(l.radius, w / 2, h / 2));
      else ctx.rect(-w / 2, -h / 2, w, h);
    } else if (l.kind === 'ellipse') {
      ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    } else {
      ctx.lineCap = 'round'; ctx.moveTo(-w / 2, 0); ctx.lineTo(w / 2, 0);
    }
    if (l.kind !== 'line' && l.fillOn) ctx.fill();
    if (l.strokeWidth > 0) ctx.stroke();
  }
}

// ---------- 画面表示 ----------
const stage = $('#stage'), viewCv = $('#view'), ovCv = $('#overlay');
const vctx = viewCv.getContext('2d'), octx = ovCv.getContext('2d');
const doc = document.createElement('canvas');           // キャンバス実寸の合成結果
const dctx = doc.getContext('2d');
const checker = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 16;
  const x = c.getContext('2d');
  x.fillStyle = '#b8b8b8'; x.fillRect(0, 0, 16, 16);
  x.fillStyle = '#e8e8e8'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
  return vctx.createPattern(c, 'repeat');
})();
const toScreen = (p) => ({ x: p.x * view.zoom + view.panX, y: p.y * view.zoom + view.panY });
const toCanvas = (p) => ({ x: (p.x - view.panX) / view.zoom, y: (p.y - view.panY) / view.zoom });

function resizeView() {
  const r = stage.getBoundingClientRect();
  view.dpr = window.devicePixelRatio || 1;
  for (const c of [viewCv, ovCv]) {
    c.width = Math.max(1, Math.round(r.width * view.dpr)); c.height = Math.max(1, Math.round(r.height * view.dpr));
    c.style.width = r.width + 'px'; c.style.height = r.height + 'px';
  }
  render();
}
let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderNow(); });
}
function renderNow() {
  const { dpr, zoom, panX, panY } = view;
  const cw = state.canvas.w, ch = state.canvas.h;
  if (doc.width !== cw || doc.height !== ch) { doc.width = cw; doc.height = ch; }
  dctx.setTransform(1, 0, 0, 1, 0, 0);
  dctx.clearRect(0, 0, cw, ch);
  // トリミング中は対象レイヤーを最前面に描いて範囲を見やすくする
  renderScene(dctx, mode && mode.kind === 'layerCrop' ? mode.layerId : null);

  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.clearRect(0, 0, viewCv.width, viewCv.height);
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sw = cw * zoom, sh = ch * zoom;
  vctx.fillStyle = state.canvas.bg === 'color' ? state.canvas.bgColor : checker;
  vctx.fillRect(panX, panY, sw, sh);
  vctx.imageSmoothingEnabled = zoom < 4;
  vctx.imageSmoothingQuality = 'high';
  vctx.drawImage(doc, panX, panY, sw, sh);
  if (grid.on && grid.size * zoom >= 5) {
    vctx.save();
    vctx.beginPath(); vctx.rect(panX, panY, sw, sh); vctx.clip();
    vctx.lineWidth = 1;
    const step = grid.size * zoom;
    for (let i = 1; i * grid.size < cw; i++) {
      const x = Math.round(panX + i * step) + .5;
      vctx.strokeStyle = i % 4 === 0 ? 'rgba(59,130,246,.75)' : 'rgba(0,0,0,.3)';
      vctx.beginPath(); vctx.moveTo(x, panY); vctx.lineTo(x, panY + sh); vctx.stroke();
    }
    for (let i = 1; i * grid.size < ch; i++) {
      const y = Math.round(panY + i * step) + .5;
      vctx.strokeStyle = i % 4 === 0 ? 'rgba(59,130,246,.75)' : 'rgba(0,0,0,.3)';
      vctx.beginPath(); vctx.moveTo(panX, y); vctx.lineTo(panX + sw, y); vctx.stroke();
    }
    vctx.restore();
  }
  vctx.strokeStyle = 'rgba(255,255,255,.25)'; vctx.lineWidth = 1;
  vctx.strokeRect(panX - .5, panY - .5, sw + 1, sh + 1);
  drawOverlay();
  syncProps();
}

// ---------- 選択枠・ハンドル ----------
const HANDLES = [
  { id: 'nw', hx: -1, hy: -1 }, { id: 'n', hx: 0, hy: -1 }, { id: 'ne', hx: 1, hy: -1 }, { id: 'e', hx: 1, hy: 0 },
  { id: 'se', hx: 1, hy: 1 }, { id: 's', hx: 0, hy: 1 }, { id: 'sw', hx: -1, hy: 1 }, { id: 'w', hx: -1, hy: 0 },
];
const HANDLE_R = 6, ROT_DIST = 28;
function handlePositions(l) {
  const out = HANDLES.map((h) => ({ ...h, ...toScreen(localToCanvas(l, h.hx * l.w / 2, h.hy * l.h / 2)) }));
  out.push({ id: 'rotate', hx: 0, hy: -1, ...toScreen(localToCanvas(l, 0, -l.h / 2 - ROT_DIST / view.zoom)) });
  return out;
}
function hitHandle(l, sp) {
  for (const h of handlePositions(l)) if (Math.hypot(h.x - sp.x, h.y - sp.y) <= HANDLE_R + 3) return h;
  return null;
}
function drawOverlay() {
  const { dpr } = view;
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, ovCv.width, ovCv.height);
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (mode) {
    const r = mode.rect;
    if (!r) return;
    const corners = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
    let pts;
    if (mode.kind === 'layerCrop') {
      const l = getLayer(mode.layerId); if (!l) return;
      pts = corners.map(([x, y]) => toScreen(localToCanvas(l, x - l.w / 2, y - l.h / 2)));
    } else {
      pts = corners.map(([x, y]) => toScreen({ x, y }));
    }
    // 選択範囲の外側を暗く
    octx.save();
    octx.fillStyle = 'rgba(0,0,0,.45)';
    octx.beginPath();
    octx.rect(0, 0, ovCv.width / dpr, ovCv.height / dpr);
    octx.moveTo(pts[0].x, pts[0].y); for (let i = 3; i >= 1; i--) octx.lineTo(pts[i].x, pts[i].y); octx.closePath();
    octx.fill('evenodd');
    octx.restore();
    strokePoly(pts, '#fff', '#000');
    return;
  }

  const l = selected();
  if (tool.kind !== 'select') {
    if (l && l.type === 'paint') strokePoly(layerCorners(l).map(toScreen), 'rgba(59,130,246,.6)', 'rgba(255,255,255,.3)');
    if (hoverSp && !spaceDown) {
      const r = Math.max(1.5, tool.size * view.zoom / 2);
      octx.lineWidth = 1;
      octx.beginPath(); octx.arc(hoverSp.x, hoverSp.y, r, 0, Math.PI * 2); octx.strokeStyle = '#000'; octx.stroke();
      octx.beginPath(); octx.arc(hoverSp.x, hoverSp.y, r + 1, 0, Math.PI * 2); octx.strokeStyle = '#fff'; octx.stroke();
      if (r < 4) { octx.fillStyle = '#fff'; octx.fillRect(hoverSp.x - 0.5, hoverSp.y - 0.5, 1, 1); }
    }
    return;
  }
  if (!l) return;
  if (drag && drag.type === 'move' && drag.guides) {
    const g = drag.guides, W = ovCv.width / dpr, H = ovCv.height / dpr;
    octx.strokeStyle = '#f472b6'; octx.lineWidth = 1; octx.setLineDash([4, 3]);
    if (g.x != null) { const x = Math.round(toScreen({ x: g.x, y: 0 }).x) + .5; octx.beginPath(); octx.moveTo(x, 0); octx.lineTo(x, H); octx.stroke(); }
    if (g.y != null) { const y = Math.round(toScreen({ x: 0, y: g.y }).y) + .5; octx.beginPath(); octx.moveTo(0, y); octx.lineTo(W, y); octx.stroke(); }
    octx.setLineDash([]);
  }
  const pts = layerCorners(l).map(toScreen);
  strokePoly(pts, l.locked ? '#f59e0b' : '#3b82f6', 'rgba(255,255,255,.8)');
  if (l.locked) return;
  const hs = handlePositions(l);
  const rot = hs[hs.length - 1], top = toScreen(localToCanvas(l, 0, -l.h / 2));
  octx.strokeStyle = '#3b82f6'; octx.lineWidth = 1;
  octx.beginPath(); octx.moveTo(top.x, top.y); octx.lineTo(rot.x, rot.y); octx.stroke();
  for (const h of hs) {
    octx.fillStyle = '#fff'; octx.strokeStyle = '#3b82f6'; octx.lineWidth = 1.5;
    octx.beginPath();
    if (h.id === 'rotate') octx.arc(h.x, h.y, HANDLE_R, 0, Math.PI * 2);
    else octx.rect(h.x - HANDLE_R + 1, h.y - HANDLE_R + 1, HANDLE_R * 2 - 2, HANDLE_R * 2 - 2);
    octx.fill(); octx.stroke();
  }
}
function strokePoly(pts, c1, c2) {
  octx.beginPath();
  pts.forEach((p, i) => (i ? octx.lineTo(p.x, p.y) : octx.moveTo(p.x, p.y)));
  octx.closePath();
  octx.lineWidth = 3; octx.strokeStyle = c2; octx.stroke();
  octx.lineWidth = 1.5; octx.strokeStyle = c1; octx.stroke();
}

// ---------- ズーム / パン ----------
function setZoom(z, cx, cy) {
  z = clamp(z, 0.05, 16);
  const k = z / view.zoom;
  view.panX = cx - (cx - view.panX) * k;
  view.panY = cy - (cy - view.panY) * k;
  view.zoom = z;
  updateZoomLabel(); render();
}
function zoomFit() {
  const r = stage.getBoundingClientRect(), pad = 40;
  const z = clamp(Math.min((r.width - pad * 2) / state.canvas.w, (r.height - pad * 2) / state.canvas.h), 0.05, 4);
  view.zoom = z;
  view.panX = Math.round((r.width - state.canvas.w * z) / 2);
  view.panY = Math.round((r.height - state.canvas.h * z) / 2);
  updateZoomLabel(); render();
}
function updateZoomLabel() { $('#zoomLabel').textContent = Math.round(view.zoom * 100) + '%'; }
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = ovCv.getBoundingClientRect();
  setZoom(view.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
$('#zoomIn').onclick = () => setZoom(view.zoom * 1.25, ovCv.clientWidth / 2, ovCv.clientHeight / 2);
$('#zoomOut').onclick = () => setZoom(view.zoom / 1.25, ovCv.clientWidth / 2, ovCv.clientHeight / 2);
$('#zoomFit').onclick = zoomFit;
$('#zoom100').onclick = () => setZoom(1, ovCv.clientWidth / 2, ovCv.clientHeight / 2);

// =====================================================================
//  描画ツール（ペン / ブラシ / 消しゴム）
// =====================================================================
const tool = { kind: 'select', size: 12, color: '#ff3b30', opacity: 1, pressure: true };
let stroke = null;    // 描画中: { layerId, cv, ctx, preview, pctx, last, eraser, opacity }
let hoverSp = null;   // ブラシカーソル表示用
const TOOL_KEYS = { v: 'select', p: 'pen', b: 'brush', e: 'eraser' };

function setTool(kind) {
  tool.kind = kind;
  for (const b of document.querySelectorAll('#tools button[data-tool]')) b.classList.toggle('active', b.dataset.tool === kind);
  $('#toolOpts').hidden = kind === 'select';
  $('#brushColor').disabled = kind === 'eraser';
  ovCv.style.cursor = kind === 'select' ? '' : 'none';
  if (mode) exitMode(false);
  render();
}
// キャンバス座標 -> 描画レイヤーのビットマップ座標（k: 長さの倍率）
function toBitmap(l, cp) {
  const q = canvasToLocal(l, cp);
  const bmp = images.get(l.imgId);
  const kx = bmp.width / l.w, ky = bmp.height / l.h;
  return { x: ((l.flipX ? -q.x : q.x) + l.w / 2) * kx, y: ((l.flipY ? -q.y : q.y) + l.h / 2) * ky, k: (kx + ky) / 2 };
}
function beginStroke(e) {
  let l = selected();
  if (!l || l.type !== 'paint' || l.locked || !l.visible) {
    l = makePaintLayer();
    addLayer(l, { center: false });
    updateLayerList();
  }
  const bmp = images.get(l.imgId);
  const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
  const preview = document.createElement('canvas'); preview.width = bmp.width; preview.height = bmp.height;
  stroke = { layerId: l.id, cv, ctx: cv.getContext('2d'), preview, pctx: preview.getContext('2d'),
    last: null, eraser: tool.kind === 'eraser', opacity: tool.opacity };
  strokeTo(e);
}
function strokeTo(e) {
  const l = getLayer(stroke.layerId); if (!l) return;
  let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  if (!evs.length) evs = [e];
  for (const ev of evs) {
    const p = toBitmap(l, toCanvas(ptr(ev)));
    const pr = (tool.pressure && ev.pointerType === 'pen') ? clamp(ev.pressure, 0.05, 1) : 1;
    const pt = { x: p.x, y: p.y, w: Math.max(0.5, tool.size * pr * p.k) };
    drawSegment(stroke.ctx, stroke.last, pt);
    stroke.last = pt;
  }
  // プレビュー = 現在のビットマップ + 描画中のストローク（不透明度・消しゴムをレイヤー内で合成）
  const { pctx, preview } = stroke;
  pctx.globalAlpha = 1; pctx.globalCompositeOperation = 'source-over';
  pctx.clearRect(0, 0, preview.width, preview.height);
  pctx.drawImage(images.get(l.imgId), 0, 0);
  pctx.globalAlpha = stroke.opacity; pctx.globalCompositeOperation = stroke.eraser ? 'destination-out' : 'source-over';
  pctx.drawImage(stroke.cv, 0, 0);
  render();
}
function drawSegment(ctx, a, b) {
  const color = tool.kind === 'eraser' ? '#000000' : tool.color;
  if (tool.kind === 'brush') {
    // ソフトブラシ: 放射状グラデーションのスタンプを等間隔に打つ
    const stamp = (x, y, w) => {
      const r = Math.max(0.5, w / 2);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, color); g.addColorStop(0.4, color); g.addColorStop(1, color + '00');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    };
    if (!a) { stamp(b.x, b.y, b.w); return; }
    const d = Math.hypot(b.x - a.x, b.y - a.y), step = Math.max(0.5, Math.min(a.w, b.w) / 5);
    const n = Math.max(1, Math.ceil(d / step));
    for (let i = 1; i <= n; i++) { const t = i / n; stamp(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.w + (b.w - a.w) * t); }
    return;
  }
  ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (!a) { ctx.beginPath(); ctx.arc(b.x, b.y, b.w / 2, 0, Math.PI * 2); ctx.fill(); return; }
  ctx.lineWidth = (a.w + b.w) / 2;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
}
function endStroke() {
  const st = stroke; stroke = null;
  const l = getLayer(st.layerId); if (!l) return;
  const bmp = images.get(l.imgId), ctx = bmp.getContext('2d');
  ctx.globalAlpha = st.opacity; ctx.globalCompositeOperation = st.eraser ? 'destination-out' : 'source-over';
  ctx.drawImage(st.cv, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  l.rev++;
  savePaintRev(l.imgId, l.rev, bmp);
  commit();
}
// Alt+クリック: 合成結果から色を取得
function pickColor(cp) {
  const x = Math.floor(cp.x), y = Math.floor(cp.y);
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
  const d = dctx.getImageData(x, y, 1, 1).data;
  if (d[3] === 0) return;
  tool.color = '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
  $('#brushColor').value = tool.color;
}
for (const b of document.querySelectorAll('#tools button[data-tool]')) b.onclick = () => setTool(b.dataset.tool);
$('#brushColor').addEventListener('input', (e) => { tool.color = e.target.value; });
$('#brushSize').addEventListener('input', (e) => { tool.size = parseInt(e.target.value, 10); $('#brushSizeVal').textContent = tool.size; });
$('#brushOpacity').addEventListener('input', (e) => { tool.opacity = parseInt(e.target.value, 10) / 100; $('#brushOpacityVal').textContent = e.target.value; });
$('#brushPressure').addEventListener('change', (e) => { tool.pressure = e.target.checked; });
function setBrushSize(v) { tool.size = clamp(Math.round(v), 1, 300); $('#brushSize').value = tool.size; $('#brushSizeVal').textContent = tool.size; drawOverlay(); }

// =====================================================================
//  ポインタ操作
// =====================================================================
const ptr = (e) => { const r = ovCv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

ovCv.addEventListener('pointerdown', (e) => {
  if (isEditable(document.activeElement)) document.activeElement.blur();
  const sp = ptr(e), cp = toCanvas(sp);
  ovCv.setPointerCapture(e.pointerId);

  if (e.button === 1 || spaceDown) {
    drag = { type: 'pan', sp, panX0: view.panX, panY0: view.panY };
    ovCv.style.cursor = 'grabbing';
    return;
  }
  if (e.button !== 0) return;

  if (mode) {
    const start = mode.kind === 'layerCrop' ? layerLocalTL(getLayer(mode.layerId), cp) : clampToCanvas(cp);
    drag = { type: 'rect', start };
    mode.rect = null;
    render();
    return;
  }
  if (tool.kind !== 'select') {
    if (e.altKey) { pickColor(cp); return; }
    drag = { type: 'paint' };
    beginStroke(e);
    return;
  }

  const l = selected();
  if (l && !l.locked) {
    const h = hitHandle(l, sp);
    if (h) {
      const c = { x: l.x + l.w / 2, y: l.y + l.h / 2 };
      if (h.id === 'rotate') drag = { type: 'rotate', c, a0: Math.atan2(cp.y - c.y, cp.x - c.x), r0: l.rotation };
      else drag = { type: 'resize', h, l0: { ...l } };
      return;
    }
  }
  const hit = hitLayer(cp);
  if (hit) {
    if (hit.id !== state.selectedId) select(hit.id);
    if (!hit.locked) drag = { type: 'move', cp, x0: hit.x, y0: hit.y };
  } else if (state.selectedId) {
    select(null);
  }
});

ovCv.addEventListener('pointermove', (e) => {
  const sp = ptr(e), cp = toCanvas(sp);
  hoverSp = sp;
  if (!drag) { if (tool.kind !== 'select') drawOverlay(); else updateCursor(sp, cp); return; }
  const l = selected();
  switch (drag.type) {
    case 'paint':
      if (stroke) strokeTo(e); return;
    case 'pan':
      view.panX = drag.panX0 + sp.x - drag.sp.x; view.panY = drag.panY0 + sp.y - drag.sp.y;
      render(); return;
    case 'rect': {
      const p = mode.kind === 'layerCrop' ? layerLocalTL(getLayer(mode.layerId), cp) : clampToCanvas(cp);
      const s = drag.start;
      mode.rect = { x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) };
      updateCropMsg(); render(); return;
    }
    case 'move': {
      if (!l) return;
      let dx = cp.x - drag.cp.x, dy = cp.y - drag.cp.y;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      l.x = Math.round(drag.x0 + dx); l.y = Math.round(drag.y0 + dy);
      drag.guides = null;
      if (grid.snap && !e.altKey) drag.guides = snapLayer(l, e.shiftKey ? (Math.abs(dx) > Math.abs(dy) ? 'x' : 'y') : null);
      drag.changed = true; render(); return;
    }
    case 'rotate': {
      if (!l) return;
      let r = drag.r0 + (Math.atan2(cp.y - drag.c.y, cp.x - drag.c.x) - drag.a0) / DEG;
      if (e.shiftKey) r = Math.round(r / 15) * 15;
      l.rotation = ((Math.round(r * 10) / 10) % 360 + 360) % 360;
      drag.changed = true; render(); return;
    }
    case 'resize': {
      if (!l) return;
      doResize(l, e, cp); drag.changed = true; render(); return;
    }
  }
});
const endDrag = () => {
  if (!drag) return;
  const { changed, type } = drag;
  drag = null;
  ovCv.style.cursor = spaceDown ? 'grab' : tool.kind === 'select' ? '' : 'none';
  if (type === 'paint') { if (stroke) endStroke(); return; }
  if (changed) commit();
};
ovCv.addEventListener('pointerup', endDrag);
ovCv.addEventListener('pointerleave', () => { hoverSp = null; if (tool.kind !== 'select') drawOverlay(); });
ovCv.addEventListener('pointercancel', endDrag);
ovCv.addEventListener('dblclick', () => {
  const l = selected();
  if (l && l.type === 'text') { const ta = $('#props textarea'); if (ta) ta.focus(); }
});

// 吸着: レイヤーの外接矩形の端・中心を、グリッド線とキャンバスの端・中心に合わせる（Alt で無効）
// axis を指定するとその軸だけ吸着する。戻り値は表示用のガイド線 { x?, y? }
function snapLayer(l, axis) {
  const thr = 6 / view.zoom;
  const lines = (len) => {
    const out = [0, len / 2, len];
    if (grid.on) for (let v = grid.size; v < len; v += grid.size) out.push(v);
    return out;
  };
  const best = (targets, vals) => {
    let d = thr, hit = null;
    for (const v of vals) for (const t of targets) { const k = Math.abs(t - v); if (k < d) { d = k; hit = { delta: t - v, at: t }; } }
    return hit;
  };
  const guides = {};
  const b = layerBBox(l);
  if (axis !== 'y') { const h = best(lines(state.canvas.w), [b.x, b.x + b.w / 2, b.x + b.w]); if (h) { l.x = Math.round(l.x + h.delta); guides.x = h.at; } }
  if (axis !== 'x') { const h = best(lines(state.canvas.h), [b.y, b.y + b.h / 2, b.y + b.h]); if (h) { l.y = Math.round(l.y + h.delta); guides.y = h.at; } }
  return guides;
}

// 角ハンドル: 既定で比率固定（Shiftで解除） / 辺ハンドル: 既定で自由（Shiftで比率固定） / Alt: 中心固定
function doResize(l, e, cp) {
  const { h, l0 } = drag;
  const lp = canvasToLocal(l0, cp);
  const alt = e.altKey;
  const keepAspect = (h.hx && h.hy) ? !e.shiftKey : e.shiftKey;
  const ax = alt ? 0 : -h.hx * l0.w / 2, ay = alt ? 0 : -h.hy * l0.h / 2;
  let nw = l0.w, nh = l0.h;
  if (h.hx) nw = alt ? Math.abs(lp.x) * 2 : h.hx * (lp.x - ax);
  if (h.hy) nh = alt ? Math.abs(lp.y) * 2 : h.hy * (lp.y - ay);
  nw = Math.max(1, nw); nh = Math.max(1, nh);
  if (keepAspect) {
    const r = l0.w / l0.h;
    if (h.hx && h.hy) { if (nw / l0.w > nh / l0.h) nh = nw / r; else nw = nh * r; }
    else if (h.hx) nh = nw / r; else nw = nh * r;
  }
  const ccx = (alt || !h.hx) ? 0 : ax + h.hx * nw / 2;
  const ccy = (alt || !h.hy) ? 0 : ay + h.hy * nh / 2;
  const c = localToCanvas(l0, ccx, ccy);
  l.w = Math.round(nw * 10) / 10; l.h = Math.round(nh * 10) / 10;
  l.x = Math.round((c.x - nw / 2) * 10) / 10; l.y = Math.round((c.y - nh / 2) * 10) / 10;
}

function updateCursor(sp, cp) {
  if (spaceDown) { ovCv.style.cursor = 'grab'; return; }
  if (tool.kind !== 'select') { ovCv.style.cursor = 'none'; return; }
  if (mode) { ovCv.style.cursor = 'crosshair'; return; }
  const l = selected();
  if (l && !l.locked) {
    const h = hitHandle(l, sp);
    if (h) {
      if (h.id === 'rotate') { ovCv.style.cursor = 'grab'; return; }
      const a = ((Math.atan2(h.hy, h.hx) / DEG + l.rotation) % 180 + 180) % 180;
      ovCv.style.cursor = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.round(a / 45) % 4];
      return;
    }
  }
  const hit = hitLayer(cp);
  ovCv.style.cursor = hit ? (hit.locked ? 'not-allowed' : 'move') : '';
}

// レイヤーの左上原点ローカル座標（回転を考慮、範囲内にクランプ）
function layerLocalTL(l, cp) {
  const q = canvasToLocal(l, cp);
  return { x: clamp(q.x + l.w / 2, 0, l.w), y: clamp(q.y + l.h / 2, 0, l.h) };
}
const clampToCanvas = (p) => ({ x: clamp(Math.round(p.x), 0, state.canvas.w), y: clamp(Math.round(p.y), 0, state.canvas.h) });

// =====================================================================
//  トリミング / キャンバス切り抜きモード
// =====================================================================
function enterMode(kind) {
  const l = selected();
  if (kind === 'layerCrop' && (!l || l.type !== 'image')) return;
  mode = { kind, layerId: l ? l.id : null, rect: null };
  $('#cropBar').hidden = false;
  $('#btnCanvasCrop').classList.toggle('active', kind === 'canvasCrop');
  updateCropMsg(); render();
}
function exitMode(rerender = true) {
  mode = null;
  $('#cropBar').hidden = true;
  $('#btnCanvasCrop').classList.remove('active');
  if (rerender) render();
}
function updateCropMsg() {
  if (!mode) return;
  const base = mode.kind === 'layerCrop' ? 'トリミング: レイヤー上で残す範囲をドラッグ' : 'キャンバス切り抜き: 残す範囲をドラッグ';
  const r = mode.rect;
  $('#cropMsg').textContent = r && r.w >= 1 && r.h >= 1 ? `${base}（${Math.round(r.w)} × ${Math.round(r.h)} px）` : base;
}
function applyMode() {
  const r = mode && mode.rect;
  if (!r || r.w < 1 || r.h < 1) { exitMode(); return; }
  if (mode.kind === 'layerCrop') {
    const l = getLayer(mode.layerId); if (!l) { exitMode(); return; }
    const c = l.crop, kx = c.sw / l.w, ky = c.sh / l.h;
    const rx = l.flipX ? l.w - r.x - r.w : r.x;
    const ry = l.flipY ? l.h - r.y - r.h : r.y;
    const nc = localToCanvas(l, r.x + r.w / 2 - l.w / 2, r.y + r.h / 2 - l.h / 2);
    l.crop = { sx: c.sx + rx * kx, sy: c.sy + ry * ky, sw: r.w * kx, sh: r.h * ky };
    l.w = Math.round(r.w); l.h = Math.round(r.h);
    l.x = Math.round(nc.x - r.w / 2); l.y = Math.round(nc.y - r.h / 2);
  } else {
    const rx = Math.round(r.x), ry = Math.round(r.y);
    state.canvas.w = Math.max(1, Math.round(r.w)); state.canvas.h = Math.max(1, Math.round(r.h));
    for (const l of state.layers) { l.x -= rx; l.y -= ry; }
  }
  exitMode(false);
  commit();
}
$('#cropApply').onclick = applyMode;
$('#cropCancel').onclick = () => exitMode();
$('#btnCanvasCrop').onclick = () => ((mode && mode.kind === 'canvasCrop') ? exitMode() : enterMode('canvasCrop'));

// =====================================================================
//  グリッド
// =====================================================================
function saveGrid() { try { localStorage.setItem('browser-img-edit.grid', JSON.stringify(grid)); } catch (e) { /* ignore */ } }
function updateGridUI() {
  $('#btnGrid').classList.toggle('active', grid.on);
  $('#gridSize').value = String(grid.size);
  $('#snapOn').checked = grid.snap;
}
$('#btnGrid').onclick = () => { grid.on = !grid.on; saveGrid(); updateGridUI(); render(); };
$('#gridSize').addEventListener('change', (e) => { grid.size = clamp(parseInt(e.target.value, 10) || 32, 2, 1024); saveGrid(); render(); });
$('#snapOn').addEventListener('change', (e) => { grid.snap = e.target.checked; saveGrid(); });
updateGridUI();

// =====================================================================
//  レイヤー結合
// =====================================================================
// 複数レイヤーを1枚の描画レイヤーに焼き込む（不透明度・合成モード・補正はレイヤー間で適用された結果になる）
function rasterizeLayers(layers, name) {
  const bs = layers.map((l) => { const b = layerBBox(l), pad = Math.ceil((l.filters.blur || 0) * 3); return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 }; });
  const x = Math.floor(Math.min(...bs.map((b) => b.x))), y = Math.floor(Math.min(...bs.map((b) => b.y)));
  const w = clamp(Math.ceil(Math.max(...bs.map((b) => b.x + b.w))) - x, 1, 16384), h = clamp(Math.ceil(Math.max(...bs.map((b) => b.y + b.h))) - y, 1, 16384);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.translate(-x, -y);
  for (const l of layers) if (l.visible) renderLayer(ctx, l);   // 非表示のレイヤーは内容を捨てる
  const nl = baseLayer('paint', name);
  nl.imgId = nl.id; nl.rev = 0; images.set(nl.imgId, cv); savePaintRev(nl.imgId, 0, cv);
  nl.x = x; nl.y = y; nl.w = w; nl.h = h;
  return nl;
}
function mergeDown() {
  const l = selected(); if (!l) return;
  const i = layerIndex(l.id);
  if (i <= 0) { toast('下にレイヤーがありません', 2500); return; }
  const below = state.layers[i - 1];
  const nl = rasterizeLayers([below, l], below.name);
  state.layers.splice(i - 1, 2, nl);
  state.selectedId = nl.id;
  commit();
}
function mergeVisible() {
  const vis = state.layers.filter((l) => l.visible);
  if (vis.length < 2) { toast('統合できる表示レイヤーが2枚以上ありません', 2500); return; }
  const nl = rasterizeLayers(vis, '統合');
  const top = layerIndex(vis[vis.length - 1].id);
  state.layers.splice(top, 1, nl);
  state.layers = state.layers.filter((l) => l.visible === false || l.id === nl.id);
  state.selectedId = nl.id;
  commit();
}
$('#layerMerge').onclick = mergeDown;
$('#layerMergeVisible').onclick = mergeVisible;

// =====================================================================
//  キャンバス全体の回転 / 反転
// =====================================================================
function rotateCanvas(deg) {
  const W = state.canvas.w, H = state.canvas.h;
  for (const l of state.layers) {
    const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
    let nx, ny;
    if (deg === 90) { nx = H - cy; ny = cx; } else if (deg === -90) { nx = cy; ny = W - cx; } else { nx = W - cx; ny = H - cy; }
    l.rotation = ((l.rotation + deg) % 360 + 360) % 360;
    l.x = Math.round((nx - l.w / 2) * 10) / 10; l.y = Math.round((ny - l.h / 2) * 10) / 10;
  }
  if (deg !== 180) { state.canvas.w = H; state.canvas.h = W; }
  commit(); zoomFit();
}
function flipCanvas(horizontal) {
  const W = state.canvas.w, H = state.canvas.h;
  for (const l of state.layers) {
    const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
    // 鏡映: 内容を反転し、回転角の符号を反転する（F·R(θ) = R(-θ)·F）
    if (horizontal) { l.flipX = !l.flipX; l.x = Math.round((W - cx - l.w / 2) * 10) / 10; }
    else { l.flipY = !l.flipY; l.y = Math.round((H - cy - l.h / 2) * 10) / 10; }
    l.rotation = ((360 - l.rotation) % 360 + 360) % 360;
  }
  commit();
}
$('#canvasRotL').onclick = () => rotateCanvas(-90);
$('#canvasRotR').onclick = () => rotateCanvas(90);
$('#canvasRot180').onclick = () => rotateCanvas(180);
$('#canvasFlipX').onclick = () => flipCanvas(true);
$('#canvasFlipY').onclick = () => flipCanvas(false);

// =====================================================================
//  キャンバス設定
// =====================================================================
function fitCanvasTo(bbox) {
  if (!bbox || bbox.w < 1 || bbox.h < 1) return;
  const ox = Math.floor(bbox.x), oy = Math.floor(bbox.y);
  state.canvas.w = Math.ceil(bbox.x + bbox.w) - ox; state.canvas.h = Math.ceil(bbox.y + bbox.h) - oy;
  for (const l of state.layers) { l.x -= ox; l.y -= oy; }
  commit(); zoomFit();
}
$('#btnFitSelected').onclick = () => { const l = selected(); if (l) fitCanvasTo(layerBBox(l)); };
$('#btnFitAll').onclick = () => {
  const vis = state.layers.filter((l) => l.visible);
  if (!vis.length) return;
  const bs = vis.map(layerBBox);
  const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
  fitCanvasTo({ x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y });
};
for (const [id, key] of [['#canvasW', 'w'], ['#canvasH', 'h']]) {
  $(id).addEventListener('change', (e) => {
    const v = Math.round(parseFloat(e.target.value));
    if (!(v >= 1)) { e.target.value = state.canvas[key]; return; }
    state.canvas[key] = Math.min(v, 16384); commit();
  });
  $(id).addEventListener('keydown', (e) => e.stopPropagation());
}
$('#canvasBgMode').addEventListener('change', (e) => { state.canvas.bg = e.target.value; commit(); });
$('#canvasBgColor').addEventListener('input', (e) => { state.canvas.bgColor = e.target.value; render(); });
$('#canvasBgColor').addEventListener('change', () => commit());
function updateCanvasInputs() {
  if (document.activeElement !== $('#canvasW')) $('#canvasW').value = state.canvas.w;
  if (document.activeElement !== $('#canvasH')) $('#canvasH').value = state.canvas.h;
  $('#canvasBgMode').value = state.canvas.bg;
  $('#canvasBgColor').value = state.canvas.bgColor;
  $('#canvasBgColor').style.visibility = state.canvas.bg === 'color' ? '' : 'hidden';
}

// =====================================================================
//  画像読み込み
// =====================================================================
// 通知（エラーなどを画面に表示）
let toastTimer = null;
function toast(msg, ms = 6000) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
$('#toast').onclick = () => { $('#toast').hidden = true; };

// File.type は OS の拡張子→MIME 設定に依存し、環境によっては空になるため拡張子でも判定する
const IMAGE_EXT = /\.(png|jpe?g|jfif|pjpeg|gif|webp|bmp|dib|svgz?|avif|ico|cur|tiff?|heic|heif)$/i;
const isImageFile = (f) => f.type.startsWith('image/') || (!f.type && IMAGE_EXT.test(f.name || ''));

const isProjectFile = (f) => /\.json$/i.test(f.name || '') || f.type === 'application/json';
async function loadFiles(files) {
  const all = [...files];
  if (!all.length) return;
  const proj = all.find(isProjectFile);
  if (proj) { openProjectFile(proj); return; }
  const list = all.filter(isImageFile);
  if (!list.length) {
    toast(`画像ファイルではないため読み込めません: ${all.map((f) => f.name || '(名前なし)').join(', ')}`);
    return;
  }
  const skipped = all.length - list.length;
  let added = 0;
  const failed = [];
  for (const f of list) {
    try {
      const img = await loadImage(f);
      const first = state.layers.length === 0;
      const l = makeImageLayer(img, (f.name || '').replace(/\.[^.]+$/, '') || '画像', f);
      if (first) { state.canvas.w = img.naturalWidth; state.canvas.h = img.naturalHeight; addLayer(l, { center: false }); }
      else addLayer(l);
      added++;
      if (first) zoomFit();
    } catch (err) {
      console.error('画像の読み込みに失敗:', f.name, err);
      failed.push(f.name || '(名前なし)');
    }
  }
  if (added) commit();
  const msgs = [];
  if (failed.length) msgs.push(`読み込めませんでした（ブラウザが対応していない形式か、ファイルが壊れています）: ${failed.join(', ')}`);
  if (skipped) msgs.push(`画像以外の ${skipped} 件をスキップしました`);
  if (msgs.length) toast(msgs.join('\n'));
}
function loadImage(file) {
  return new Promise((resolve, reject) => {
    if (file.size === 0) { reject(new Error('empty file')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode error')); };
    img.src = url;
  });
}
$('#btnOpen').onclick = () => $('#fileInput').click();
$('#fileInput').addEventListener('change', (e) => { loadFiles(e.target.files); e.target.value = ''; });
// ドロップはページ全体で受け付ける（ツールバー等に落としてもブラウザが画像を開いてしまわないように）
const hasFileDrag = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
document.addEventListener('dragover', (e) => {
  if (dragLayerId || !hasFileDrag(e)) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; stage.classList.add('dragover');
});
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) stage.classList.remove('dragover'); });
document.addEventListener('drop', (e) => {
  stage.classList.remove('dragover');
  if (dragLayerId) return;
  e.preventDefault();
  if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
  else if (e.dataTransfer.types.length) toast('ファイルを受け取れませんでした。エクスプローラー等からファイルをドロップしてください（リモートデスクトップやブラウザ内の画像からのドロップは非対応です）');
});
document.addEventListener('paste', (e) => {
  if (isEditable(e.target)) return;
  const items = e.clipboardData ? [...e.clipboardData.items] : [];
  const files = items.filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  loadFiles(files.map((f, i) => new File([f], f.name || `貼り付け${i + 1}.png`, { type: f.type })));
});

// =====================================================================
//  プロジェクトの保存 / 読み込み / 自動保存
// =====================================================================
const PROJECT_APP = 'browser-img-edit';
const blobToDataURL = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
function dataURLToBlob(u) {
  const i = u.indexOf(','), meta = u.slice(5, i), b64 = u.slice(i + 1);
  const type = meta.split(';')[0] || 'application/octet-stream';
  const bin = atob(b64), arr = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
  return new Blob([arr], { type });
}
// 現在の状態を { meta, images: {imgId: Blob} } にまとめる
async function serializeProject() {
  const imgs = {};
  for (const l of state.layers) {
    if (!l.imgId || imgs[l.imgId]) continue;
    const src = images.get(l.imgId); if (!src) continue;
    let blob = imageBlobs.get(l.imgId);
    if (!blob) {
      let cv = src;
      if (!(src instanceof HTMLCanvasElement)) { cv = document.createElement('canvas'); cv.width = src.naturalWidth; cv.height = src.naturalHeight; cv.getContext('2d').drawImage(src, 0, 0); }
      blob = await canvasToBlob(cv);
    }
    imgs[l.imgId] = blob;
  }
  return { app: PROJECT_APP, version: 1, savedAt: Date.now(), canvas: state.canvas, layers: state.layers, selectedId: state.selectedId, images: imgs };
}
// プロジェクトを現在の状態に展開する（images の値は Blob または dataURL）。ID は付け直す
async function loadProject(data) {
  if (!data || data.app !== PROJECT_APP || !Array.isArray(data.layers)) throw new Error('not a project');
  const idMap = new Map();
  const layers = [];
  for (const src of data.layers) {
    const l = { ...baseLayer(src.type, src.name || 'レイヤー'), ...src };
    l.id = uid(); l.filters = { ...defaultFilters(), ...(src.filters || {}) };
    if (src.imgId) {
      if (!idMap.has(src.imgId)) idMap.set(src.imgId, l.type === 'paint' ? l.id : l.id);
      l.imgId = idMap.get(src.imgId);
    }
    layers.push(l);
  }
  const newImages = new Map(), newBlobs = new Map();
  for (const [oldId, newId] of idMap) {
    const v = data.images && data.images[oldId];
    if (!v) throw new Error('image missing: ' + oldId);
    const blob = typeof v === 'string' ? dataURLToBlob(v) : v;
    const img = await loadImage(blob);
    const isPaint = layers.some((l) => l.imgId === newId && l.type === 'paint');
    if (isPaint) {
      const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      cv.getContext('2d').drawImage(img, 0, 0);
      newImages.set(newId, cv);
    } else { newImages.set(newId, img); newBlobs.set(newId, blob); }
  }
  // ここまで失敗なし。状態を差し替える
  for (const [id, v] of newImages) images.set(id, v);
  for (const [id, v] of newBlobs) imageBlobs.set(id, v);
  for (const l of layers) if (l.type === 'paint') { l.rev = 0; savePaintRev(l.imgId, 0, images.get(l.imgId)); }
  const c = data.canvas || {};
  state.canvas = { w: clamp(Math.round(c.w) || 1280, 1, 16384), h: clamp(Math.round(c.h) || 720, 1, 16384), bg: c.bg === 'color' ? 'color' : 'transparent', bgColor: c.bgColor || '#ffffff' };
  state.layers = layers;
  const selOld = data.layers.findIndex((l) => l.id === data.selectedId);
  state.selectedId = selOld >= 0 ? layers[selOld].id : null;
  exitMode(false);
  commit();
  zoomFit();
}
async function openProjectFile(file) {
  try {
    const data = JSON.parse(await file.text());
    await loadProject(data);
    toast(`プロジェクト「${file.name}」を読み込みました（Ctrl+Z で戻せます）`, 4000);
  } catch (err) {
    console.error(err);
    toast(`プロジェクトを読み込めませんでした: ${file.name}`);
  }
}
async function saveProjectFile(name) {
  const p = await serializeProject();
  const imgs = {};
  for (const [id, b] of Object.entries(p.images)) imgs[id] = await blobToDataURL(b);
  const json = JSON.stringify({ ...p, images: imgs });
  const blob = new Blob([json], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const saveModal = $('#saveModal');
$('#btnSave').onclick = () => { saveModal.hidden = false; $('#saveName').focus(); $('#saveName').select(); };
$('#saveCancel').onclick = () => { saveModal.hidden = true; };
saveModal.addEventListener('click', (e) => { if (e.target === saveModal) saveModal.hidden = true; });
$('#saveName').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') $('#saveDo').click(); if (e.key === 'Escape') saveModal.hidden = true; });
$('#saveDo').onclick = async () => {
  const name = ($('#saveName').value.trim() || 'project').replace(/\.json$/i, '') + '.json';
  saveModal.hidden = true;
  try { await saveProjectFile(name); } catch (err) { console.error(err); toast('保存に失敗しました'); }
};
$('#btnNew').onclick = () => {
  if (!state.layers.length) return;
  state.layers = []; state.selectedId = null;
  state.canvas = { w: 1280, h: 720, bg: 'transparent', bgColor: '#ffffff' };
  exitMode(false); commit(); zoomFit();
  toast('新規キャンバスにしました（Ctrl+Z で戻せます）', 3000);
};

// ---------- 自動保存（IndexedDB） ----------
const AUTOSAVE_KEY = 'autosave';
let idbPromise = null;
function idbOpen() {
  if (!idbPromise) idbPromise = new Promise((res, rej) => {
    if (!window.indexedDB) { rej(new Error('no indexedDB')); return; }
    const r = indexedDB.open(PROJECT_APP, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('blocked'));
  });
  return idbPromise;
}
async function idbReq(mode, fn) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', mode), req = fn(tx.objectStore('kv'));
    req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
  });
}
let autosaveTimer = null, autosaving = false, autosaveDirty = false, autosaveBroken = false;
function scheduleAutosave() {
  if (autosaveBroken) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(autosaveNow, 1500);
}
async function autosaveNow() {
  if (autosaving) { autosaveDirty = true; return; }
  autosaving = true;
  try {
    if (!state.layers.length) { await idbReq('readwrite', (st) => st.delete(AUTOSAVE_KEY)); }
    else {
      const data = await serializeProject();   // トランザクションの外で先に作る（await をまたぐと tx が閉じるため）
      await idbReq('readwrite', (st) => st.put(data, AUTOSAVE_KEY));
    }
  } catch (err) {
    // 保存先が使えない環境（プライベートモード等）では以後あきらめる
    console.warn('自動保存できません:', err); autosaveBroken = true;
  } finally {
    autosaving = false;
    if (autosaveDirty) { autosaveDirty = false; scheduleAutosave(); }
  }
}
window.addEventListener('beforeunload', () => { if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveNow(); } });
// 起動時: 前回の自動保存があれば復元を提案する（データはメモリに保持し、その後の自動保存で上書きされても復元できるようにする）
let pendingRestore = null;
async function checkAutosave() {
  let data = null;
  try { data = await idbReq('readonly', (st) => st.get(AUTOSAVE_KEY)); } catch (err) { console.warn('自動保存を読めません:', err); autosaveBroken = true; return; }
  if (!data || !Array.isArray(data.layers) || !data.layers.length) return;
  pendingRestore = data;
  const d = new Date(data.savedAt || 0);
  $('#restoreMsg').textContent = `前回の作業内容があります（${d.toLocaleString()}・レイヤー ${data.layers.length} 枚）`;
  $('#restoreBar').hidden = false;
}
$('#restoreYes').onclick = async () => {
  $('#restoreBar').hidden = true;
  const data = pendingRestore; pendingRestore = null;
  if (!data) return;
  try { await loadProject(data); toast('前回の作業内容を復元しました', 3000); }
  catch (err) { console.error(err); toast('復元に失敗しました'); }
};
$('#restoreNo').onclick = async () => {
  $('#restoreBar').hidden = true; pendingRestore = null;
  try { if (!state.layers.length) await idbReq('readwrite', (st) => st.delete(AUTOSAVE_KEY)); } catch (err) { /* ignore */ }
};
checkAutosave();

// ---------- 追加ボタン ----------
$('#btnAddText').onclick = () => { addLayer(makeTextLayer()); commit(); const ta = $('#props textarea'); if (ta) { ta.focus(); ta.select(); } };
$('#btnAddRect').onclick = () => { addLayer(makeShapeLayer('rect')); commit(); };
$('#btnAddEllipse').onclick = () => { addLayer(makeShapeLayer('ellipse')); commit(); };
$('#btnAddLine').onclick = () => { addLayer(makeShapeLayer('line')); commit(); };
$('#btnAddPaint').onclick = () => { addLayer(makePaintLayer(), { center: false }); commit(); if (tool.kind === 'select') setTool('pen'); };

// =====================================================================
//  レイヤーパネル
// =====================================================================
const layerList = $('#layerList');
let dragLayerId = null;
let renamingId = null;
// 構成（IDの並び）が同じなら DOM を作り直さず差分更新する（クリック中の要素が消えないように）
function updateLayerList() {
  const order = [...state.layers].reverse();
  const cur = [...layerList.children].map((li) => li.dataset.id).join(',');
  if (cur !== order.map((l) => l.id).join(',')) {
    layerList.replaceChildren(...order.map(buildLayerItem));
  }
  for (const li of layerList.children) li._update(getLayer(li.dataset.id));
  const has = !!selected();
  for (const id of ['#layerUp', '#layerDown', '#layerDup', '#layerDel', '#layerMerge']) $(id).disabled = !has;
  $('#layerMergeVisible').disabled = state.layers.filter((l) => l.visible).length < 2;
  $('#dropHint').hidden = state.layers.length > 0;
}
function buildLayerItem(l) {
  const id = l.id;
  const thumb = el('canvas', { class: 'thumb', width: 36, height: 36 });
  const name = el('span', { class: 'name', title: 'ダブルクリックで名前を変更' });
  name.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(name, getLayer(id)); });
  const eye = el('button', { type: 'button', class: 'icon', title: '表示/非表示',
    onpointerdown: (e) => { e.stopPropagation(); e.preventDefault(); const L = getLayer(id); L.visible = !L.visible; commit(); } }, '👁');
  const lock = el('button', { type: 'button', class: 'icon', title: 'ロック（移動・変形を禁止）',
    onpointerdown: (e) => { e.stopPropagation(); e.preventDefault(); const L = getLayer(id); L.locked = !L.locked; commit(); } });
  const li = el('li', { draggable: true,
    onpointerdown: (e) => { if (e.button === 0 && !renamingId) select(id); } }, eye, thumb, name, lock);
  li.dataset.id = id;
  li.addEventListener('dragstart', (e) => { dragLayerId = id; e.dataTransfer.effectAllowed = 'move'; });
  li.addEventListener('dragover', (e) => {
    if (!dragLayerId || dragLayerId === id) return;
    e.preventDefault();
    const r = li.getBoundingClientRect(), top = e.clientY < r.top + r.height / 2;
    li.classList.toggle('dragover-top', top); li.classList.toggle('dragover-bottom', !top);
  });
  li.addEventListener('dragleave', () => li.classList.remove('dragover-top', 'dragover-bottom'));
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    li.classList.remove('dragover-top', 'dragover-bottom');
    if (!dragLayerId || dragLayerId === id) return;
    const r = li.getBoundingClientRect(), top = e.clientY < r.top + r.height / 2;
    const src = dragLayerId; dragLayerId = null;
    const from = layerIndex(src);
    let to = layerIndex(id) + (top ? 1 : 0);      // 一覧は逆順なので「上」= 配列では後ろ
    if (from < to) to--;
    moveLayer(src, to);
  });
  li.addEventListener('dragend', () => { dragLayerId = null; });
  li._update = (L) => {
    if (!L) return;
    li.classList.toggle('sel', L.id === state.selectedId);
    li.classList.toggle('hidden', !L.visible);
    eye.classList.toggle('off', !L.visible);
    lock.classList.toggle('off', !L.locked);
    lock.textContent = L.locked ? '🔒' : '🔓';
    if (renamingId !== L.id) name.textContent = L.name;
    drawThumb(thumb, L);
  };
  return li;
}
function startRename(span, l) {
  if (!l || renamingId) return;
  renamingId = l.id;
  const inp = el('input', { type: 'text', value: l.name });
  const done = () => {
    renamingId = null;
    const v = inp.value.trim();
    if (v && v !== l.name) { l.name = v; commit(); } else { span.textContent = l.name; }
  };
  inp.addEventListener('blur', done);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = l.name; inp.blur(); } e.stopPropagation(); });
  inp.addEventListener('pointerdown', (e) => e.stopPropagation());
  inp.addEventListener('dragstart', (e) => e.preventDefault());
  span.replaceChildren(inp); inp.focus(); inp.select();
}
function drawThumb(cv, l) {
  const S = cv.width, x = cv.getContext('2d');
  x.clearRect(0, 0, S, S);
  const k = Math.min(S / l.w, S / l.h) * 0.9;
  x.translate(S / 2, S / 2); x.scale(k, k); x.scale(l.flipX ? -1 : 1, l.flipY ? -1 : 1);
  drawLayerContent(x, l);
}
$('#layerUp').onclick = () => { const l = selected(); if (l) moveLayer(l.id, layerIndex(l.id) + 1); };
$('#layerDown').onclick = () => { const l = selected(); if (l) moveLayer(l.id, layerIndex(l.id) - 1); };
$('#layerDup').onclick = duplicateSelected;
$('#layerDel').onclick = deleteSelected;

// =====================================================================
//  プロパティパネル
// =====================================================================
const propsRoot = $('#props');
let propsFor = null;           // 現在パネルを構築しているレイヤーのキー
let bindings = [];             // { el, get, prop?, valEl?, fmt? }
let aspectLock = true;

function ensureProps() {
  const l = selected();
  const key = l ? `${l.id}:${l.type}:${l.kind || ''}` : null;
  if (key === propsFor) return;
  propsFor = key;
  buildProps(l);
}
function syncProps() {
  for (const b of bindings) {
    if (b.el === document.activeElement) continue;
    const v = b.get();
    if (b.prop === 'checked') b.el.checked = v;
    else if (b.prop === 'text') { if (b.el.textContent !== v) b.el.textContent = v; }
    else if (b.el.value != v) b.el.value = v;
    if (b.valEl) b.valEl.textContent = b.fmt ? b.fmt(v) : v;
  }
}
function buildProps(l) {
  bindings = [];
  propsRoot.innerHTML = '';
  if (!l) { propsRoot.append(el('p', { class: 'hint' }, 'レイヤーを選択してください')); return; }

  const sec = (title, ...rows) => el('div', { class: 'sec' }, title ? el('h3', {}, title) : null, ...rows);
  const row = (label, ...els) => el('div', { class: 'row' }, label != null ? el('span', { class: 'lbl' }, label) : null, ...els);
  // 変更中は render のみ、確定で commit
  const live = (fn) => { fn(); render(); };
  const num = (get, set, opts = {}) => {
    const e = el('input', { type: 'number', value: get(), step: opts.step != null ? opts.step : 1, min: opts.min, max: opts.max, title: opts.title || '' });
    e.addEventListener('input', () => { const v = parseFloat(e.value); if (Number.isFinite(v)) live(() => set(v)); });
    e.addEventListener('change', () => { syncProps(); commit(); });
    e.addEventListener('keydown', (ev) => ev.stopPropagation());
    bindings.push({ el: e, get });
    return e;
  };
  const range = (label, get, set, min, max, step = 1, fmt) => {
    const e = el('input', { type: 'range', min, max, step, value: get() });
    const val = el('span', { class: 'val' }, fmt ? fmt(get()) : String(get()));
    e.addEventListener('input', () => { const v = parseFloat(e.value); live(() => set(v)); val.textContent = fmt ? fmt(v) : v; });
    e.addEventListener('change', () => commit());
    bindings.push({ el: e, get, valEl: val, fmt });
    return row(label, e, val);
  };
  const color = (get, set) => {
    const e = el('input', { type: 'color', value: get() });
    e.addEventListener('input', () => live(() => set(e.value)));
    e.addEventListener('change', () => commit());
    bindings.push({ el: e, get });
    return e;
  };
  const check = (label, get, set) => {
    const e = el('input', { type: 'checkbox', checked: get() });
    e.addEventListener('change', () => { live(() => set(e.checked)); commit(); });
    bindings.push({ el: e, get, prop: 'checked' });
    return el('label', {}, e, label);
  };
  const sel = (options, get, set) => {
    const e = el('select', {}, ...options.map(([v, t]) => el('option', { value: v }, t)));
    e.value = get();
    e.addEventListener('change', () => { live(() => set(e.value)); commit(); });
    bindings.push({ el: e, get });
    return e;
  };
  const text = (get, set, opts = {}) => {
    const e = opts.multi ? el('textarea', { value: get() }) : el('input', { type: 'text', value: get() });
    if (opts.list) e.setAttribute('list', opts.list);
    e.addEventListener('input', () => live(() => set(e.value)));
    e.addEventListener('change', () => commit());
    e.addEventListener('keydown', (ev) => ev.stopPropagation());
    bindings.push({ el: e, get });
    return e;
  };
  const btn = (label, fn, cls = '') => el('button', { type: 'button', class: cls, onclick: fn }, label);

  // ---- 基本 ----
  const setW = (v) => { v = Math.max(1, v); if (aspectLock) l.h = Math.max(1, Math.round(v * l.h / l.w * 10) / 10); l.w = v; };
  const setH = (v) => { v = Math.max(1, v); if (aspectLock) l.w = Math.max(1, Math.round(v * l.w / l.h * 10) / 10); l.h = v; };
  const lockCb = el('input', { type: 'checkbox', checked: aspectLock });
  lockCb.addEventListener('change', () => { aspectLock = lockCb.checked; });
  propsRoot.append(sec(null,
    row('名前', text(() => l.name, (v) => { l.name = v; })),
    row('位置', num(() => Math.round(l.x), (v) => { l.x = v; }, { title: 'X' }), num(() => Math.round(l.y), (v) => { l.y = v; }, { title: 'Y' })),
    row('サイズ', num(() => Math.round(l.w), setW, { min: 1, title: '幅' }), num(() => Math.round(l.h), setH, { min: 1, title: '高さ' }),
      el('label', { title: '縦横比を固定' }, lockCb, '比率')),
    row('回転', num(() => Math.round(l.rotation * 10) / 10, (v) => { l.rotation = ((v % 360) + 360) % 360; }, { step: 1 }), '°',
      btn('0°', () => { l.rotation = 0; commit(); }), btn('+90°', () => { l.rotation = (l.rotation + 90) % 360; commit(); })),
    row('反転', el('div', { class: 'btns' },
      btn('左右反転', () => { l.flipX = !l.flipX; commit(); }),
      btn('上下反転', () => { l.flipY = !l.flipY; commit(); }))),
    range('不透明度', () => Math.round(l.opacity * 100), (v) => { l.opacity = v / 100; }, 0, 100, 1, (v) => v + '%'),
    row('合成', sel(BLENDS, () => l.blend, (v) => { l.blend = v; })),
  ));

  // ---- 種類別 ----
  if (l.type === 'image') {
    const img = images.get(l.imgId);
    const infoText = () => img ? `元画像 ${img.naturalWidth} × ${img.naturalHeight} px ／ 切り抜き ${Math.round(l.crop.sw)} × ${Math.round(l.crop.sh)} px` : '';
    const info = el('span', { class: 'hint' }, infoText());
    bindings.push({ el: info, get: infoText, prop: 'text' });
    propsRoot.append(sec('画像',
      row(null, el('div', { class: 'btns' },
        btn('トリミング', () => enterMode('layerCrop')),
        btn('元のサイズに戻す', () => {
          if (!img) return;
          const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
          l.crop = { sx: 0, sy: 0, sw: img.naturalWidth, sh: img.naturalHeight };
          l.w = img.naturalWidth; l.h = img.naturalHeight; l.x = Math.round(cx - l.w / 2); l.y = Math.round(cy - l.h / 2);
          commit();
        }),
        btn('比率を元に戻す', () => { l.h = Math.round(l.w * l.crop.sh / l.crop.sw); commit(); }),
      )),
      row(null, info),
    ));
  } else if (l.type === 'text') {
    const ta = text(() => l.text, (v) => { l.text = v; retext(l); }, { multi: true });
    const fontList = el('datalist', { id: 'fontList' }, ...FONTS.map((f) => el('option', { value: f })));
    const fontIn = text(() => l.fontFamily, (v) => { l.fontFamily = v || 'sans-serif'; retext(l); }, { list: 'fontList' });
    fontIn.addEventListener('input', () => { fontIn.style.fontFamily = fontIn.value; });
    fontIn.style.fontFamily = l.fontFamily;
    propsRoot.append(sec('テキスト',
      row(null, ta),
      row('フォント', fontIn, fontList),
      row('サイズ', num(() => l.fontSize, (v) => { l.fontSize = Math.max(1, v); retext(l); }, { min: 1 }),
        check('太字', () => l.bold, (v) => { l.bold = v; retext(l); }),
        check('斜体', () => l.italic, (v) => { l.italic = v; retext(l); })),
      row('行間', num(() => l.lineHeight, (v) => { l.lineHeight = Math.max(0.5, v); retext(l); }, { step: 0.1, min: 0.5 }),
        sel([['left', '左揃え'], ['center', '中央'], ['right', '右揃え']], () => l.align, (v) => { l.align = v; })),
      row('文字色', color(() => l.color, (v) => { l.color = v; })),
      row('縁取り', color(() => l.strokeColor, (v) => { l.strokeColor = v; }),
        num(() => l.strokeWidth, (v) => { l.strokeWidth = Math.max(0, v); retext(l); }, { min: 0, title: '縁取りの太さ' }), 'px'),
      row(null, btn('サイズを文字に合わせる', () => { l.w = l.natW; l.h = l.natH; commit(); })),
    ));
  } else if (l.type === 'paint') {
    const bmp = images.get(l.imgId);
    propsRoot.append(sec('描画',
      row(null, el('span', { class: 'hint' }, bmp ? `ビットマップ ${bmp.width} × ${bmp.height} px` : '')),
      row(null, el('div', { class: 'btns' },
        btn('ペンで描く', () => setTool('pen')),
        btn('描画をクリア', () => { if (!bmp) return; bmp.getContext('2d').clearRect(0, 0, bmp.width, bmp.height); l.rev++; savePaintRev(l.imgId, l.rev, bmp); commit(); }),
      )),
    ));
  } else if (l.type === 'shape') {
    const rows = [];
    if (l.kind !== 'line') rows.push(row('塗り', check('', () => l.fillOn, (v) => { l.fillOn = v; }), color(() => l.fill, (v) => { l.fill = v; })));
    rows.push(row('線', color(() => l.stroke, (v) => { l.stroke = v; }),
      num(() => l.strokeWidth, (v) => { l.strokeWidth = Math.max(0, v); }, { min: 0, title: '線の太さ' }), 'px'));
    if (l.kind === 'rect') rows.push(row('角丸', num(() => l.radius, (v) => { l.radius = Math.max(0, v); }, { min: 0 }), 'px'));
    propsRoot.append(sec('図形', ...rows));
  }

  // ---- 補正 ----
  const f = () => l.filters;
  propsRoot.append(sec('補正',
    range('明るさ', () => f().brightness, (v) => { f().brightness = v; }, 0, 200, 1, (v) => v + '%'),
    range('コントラスト', () => f().contrast, (v) => { f().contrast = v; }, 0, 200, 1, (v) => v + '%'),
    range('彩度', () => f().saturate, (v) => { f().saturate = v; }, 0, 300, 1, (v) => v + '%'),
    range('色相', () => f().hueRotate, (v) => { f().hueRotate = v; }, -180, 180, 1, (v) => v + '°'),
    range('ぼかし', () => f().blur, (v) => { f().blur = v; }, 0, 50, 0.5, (v) => v + 'px'),
    range('グレー', () => f().grayscale, (v) => { f().grayscale = v; }, 0, 100, 1, (v) => v + '%'),
    range('セピア', () => f().sepia, (v) => { f().sepia = v; }, 0, 100, 1, (v) => v + '%'),
    range('階調反転', () => f().invert, (v) => { f().invert = v; }, 0, 100, 1, (v) => v + '%'),
    row(null, btn('補正をリセット', () => { l.filters = defaultFilters(); commit(); })),
  ));

  // ---- 操作 ----
  propsRoot.append(sec(null, row(null, el('div', { class: 'btns' },
    btn('複製', duplicateSelected),
    btn('下と結合', mergeDown),
    btn('中央に配置', () => { l.x = Math.round((state.canvas.w - l.w) / 2); l.y = Math.round((state.canvas.h - l.h) / 2); commit(); }),
    btn('キャンバスに合わせる', () => {
      const k = Math.min(state.canvas.w / l.w, state.canvas.h / l.h);
      l.w = Math.round(l.w * k); l.h = Math.round(l.h * k);
      l.x = Math.round((state.canvas.w - l.w) / 2); l.y = Math.round((state.canvas.h - l.h) / 2); commit();
    }),
    btn('削除', deleteSelected, 'danger'),
  ))));
}

// =====================================================================
//  書き出し
// =====================================================================
const modal = $('#exportModal');
function openExport() {
  modal.hidden = false;
  updateExportInfo();
  $('#expName').focus();
}
function exportDims() {
  const modeV = $('#expSizeMode').value, v = parseFloat($('#expSize').value);
  const cw = state.canvas.w, ch = state.canvas.h;
  let s = 1;
  if (Number.isFinite(v) && v > 0) s = modeV === 'scale' ? v / 100 : modeV === 'width' ? v / cw : v / ch;
  return { s, w: Math.max(1, Math.round(cw * s)), h: Math.max(1, Math.round(ch * s)) };
}
function updateExportInfo() {
  const fmt = $('#expFormat').value;
  $('#expQualityRow').style.display = fmt === 'image/png' ? 'none' : '';
  $('#expQualityVal').textContent = $('#expQuality').value;
  const d = exportDims();
  $('#expInfo').textContent = `出力サイズ: ${d.w} × ${d.h} px`;
}
for (const id of ['#expFormat', '#expSizeMode', '#expSize', '#expQuality']) $(id).addEventListener('input', updateExportInfo);
$('#expSizeMode').addEventListener('change', () => {
  const m = $('#expSizeMode').value;
  $('#expSize').value = m === 'scale' ? 100 : m === 'width' ? state.canvas.w : state.canvas.h;
  updateExportInfo();
});
$('#btnExport').onclick = openExport;
$('#expCancel').onclick = () => { modal.hidden = true; };
modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
$('#expDo').onclick = () => {
  const fmt = $('#expFormat').value, q = parseInt($('#expQuality').value, 10) / 100;
  const d = exportDims();
  const cv = document.createElement('canvas'); cv.width = d.w; cv.height = d.h;
  const ctx = cv.getContext('2d');
  if (state.canvas.bg === 'color') { ctx.fillStyle = state.canvas.bgColor; ctx.fillRect(0, 0, d.w, d.h); }
  else if (fmt === 'image/jpeg' && $('#expWhiteBg').checked) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, d.w, d.h); }
  ctx.scale(d.s, d.s);
  renderScene(ctx);
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[fmt];
  const name = ($('#expName').value.trim() || 'image') + ext;
  cv.toBlob((blob) => {
    if (!blob) { console.error('書き出しに失敗しました'); return; }
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    modal.hidden = true;
  }, fmt, q);
};

// =====================================================================
//  キーボード
// =====================================================================
window.addEventListener('keydown', (e) => {
  if (isEditable(e.target)) return;
  if (e.key === ' ') { spaceDown = true; if (!drag) ovCv.style.cursor = 'grab'; e.preventDefault(); return; }
  if (!modal.hidden) { if (e.key === 'Escape') modal.hidden = true; return; }
  if (!saveModal.hidden) { if (e.key === 'Escape') saveModal.hidden = true; return; }
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const l = selected();
  if (ctrl && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (ctrl && k === 'y') { e.preventDefault(); redo(); return; }
  if (ctrl && k === 'd') { e.preventDefault(); duplicateSelected(); return; }
  if (ctrl && k === 'e') { e.preventDefault(); if (e.shiftKey) mergeVisible(); else mergeDown(); return; }
  if (ctrl && e.key === "'") { e.preventDefault(); $('#btnGrid').click(); return; }
  if (ctrl && k === 'o') { e.preventDefault(); $('#fileInput').click(); return; }
  if (ctrl && k === 's') { e.preventDefault(); if (e.shiftKey) $('#btnSave').click(); else openExport(); return; }
  if (ctrl && k === '0') { e.preventDefault(); zoomFit(); return; }
  if (!ctrl && !e.altKey && TOOL_KEYS[k]) { setTool(TOOL_KEYS[k]); return; }
  if (!ctrl && (e.key === '[' || e.key === ']')) { const d = tool.size < 10 ? 1 : tool.size < 50 ? 2 : 5; setBrushSize(tool.size + (e.key === ']' ? d : -d)); return; }
  if (e.key === 'Escape') { if (mode) exitMode(); else if (tool.kind !== 'select') setTool('select'); else select(null); return; }
  if (e.key === 'Enter' && mode) { applyMode(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && l) { e.preventDefault(); deleteSelected(); return; }
  if (e.key.startsWith('Arrow') && l && !l.locked) {
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') l.x -= d; if (e.key === 'ArrowRight') l.x += d;
    if (e.key === 'ArrowUp') l.y -= d; if (e.key === 'ArrowDown') l.y += d;
    commit();
  }
});
window.addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; if (!drag) ovCv.style.cursor = ''; } });
window.addEventListener('blur', () => { spaceDown = false; });
$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;

// =====================================================================
//  更新
// =====================================================================
function refresh() {
  updateLayerList();
  ensureProps();
  updateCanvasInputs();
  $('#btnUndo').disabled = history.idx <= 0;
  $('#btnRedo').disabled = history.idx >= history.stack.length - 1;
  render();
}

// 初期化
new ResizeObserver(resizeView).observe(stage);
commit();
zoomFit();
window.__appLoaded = true;
if (location.hash === '#debug') window.__dbg = { state, view, grid, images, paintRevs, history, renderNow, loadProject, serializeProject };   // 動作確認用
})();
