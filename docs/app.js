'use strict';

// ---------- ブラウザ保存（localStorage） ----------
const LS = {
  visibility: 'scm.visibility.v1', // { eventId: false } 非表示にしたイベント
  cleared: 'scm.cleared.v1',       // { spotId: true }   攻略済スポット
  options: 'scm.options.v1',       // 表示オプション
  expanded: 'scm.expanded.v1',     // サイドバーで展開中のイベント
  view: 'scm.view.v1',             // 最後の地図位置
};
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const store = (k, v) => localStorage.setItem(k, JSON.stringify(v));

const visibility = load(LS.visibility, {});
const cleared = load(LS.cleared, {});
const options = Object.assign({ labels: false, hideCleared: false }, load(LS.options, {}));
const expanded = load(LS.expanded, {});

const isVisible = (ev) => visibility[ev.id] !== false;
const isCleared = (sp) => !!cleared[sp.id];

// ---------- 状態 ----------
let data = { events: [] };
let editMode = false;
const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#808000', '#000075'];
const CLEARED_COLOR = '#888888';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'style') e.style.cssText = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
};
const fmtRadius = (m) => (m >= 1000 ? `${+(m / 1000).toFixed(2)}km` : `${m}m`);
const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const findEvent = (id) => data.events.find((e) => e.id === id);

function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = isErr ? 'err' : '';
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), isErr ? 5000 : 2000);
}

// ---------- 地図 ----------
const map = L.map('map', { zoomControl: true });
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const spotsLayer = L.layerGroup().addTo(map);
const spotLayers = new Map(); // spotId -> { circle, dot, eventId }

map.on('moveend', () => {
  const c = map.getCenter();
  store(LS.view, { lat: c.lat, lng: c.lng, z: map.getZoom() });
});

function popupContent(ev, sp) {
  const done = isCleared(sp);
  const box = el('div', {},
    el('div', { class: 'popup-title' }, sp.name),
    el('div', { class: 'popup-sub' }, `${ev.name} ／ 半径 ${fmtRadius(sp.radius)}`),
    el('button', {
      class: 'btn popup-btn' + (done ? ' cleared' : ''),
      onclick: () => { toggleCleared(sp.id); map.closePopup(); },
    }, done ? '✔ 攻略済（クリックで解除）' : '攻略済にする'),
  );
  if (editMode) {
    box.append(el('div', { class: 'row-end' },
      el('button', { class: 'btn small', onclick: () => { map.closePopup(); openSpotEditor(ev.id, sp.id); } }, '編集'),
    ));
  }
  return box;
}

function renderMap() {
  spotsLayer.clearLayers();
  spotLayers.clear();
  for (const ev of data.events) {
    if (!isVisible(ev)) continue;
    for (const sp of ev.spots) {
      const done = isCleared(sp);
      if (done && options.hideCleared) continue;
      const color = done ? CLEARED_COLOR : ev.color;
      const ll = [sp.lat, sp.lng];
      const circle = L.circle(ll, {
        radius: sp.radius, color, weight: 2, fillColor: color,
        fillOpacity: done ? 0.05 : 0.15, dashArray: done ? '6 6' : null,
      });
      const dot = L.circleMarker(ll, {
        radius: 5, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1,
      });
      dot.bindTooltip((done ? '✔ ' : '') + sp.name, {
        permanent: options.labels, direction: 'top', offset: [0, -6],
        className: options.labels ? 'spot-label' : '',
      });
      const pop = () => popupContent(ev, sp);
      circle.bindPopup(pop);
      dot.bindPopup(pop);
      spotsLayer.addLayer(circle).addLayer(dot);
      spotLayers.set(sp.id, { circle, dot });
    }
  }
}

function focusSpot(ev, sp) {
  if (!isVisible(ev)) { visibility[ev.id] = true; store(LS.visibility, visibility); refresh(); }
  const b = L.latLng(sp.lat, sp.lng).toBounds(sp.radius * 2.4);
  map.fitBounds(b, { maxZoom: 17 });
  const l = spotLayers.get(sp.id);
  if (l) l.dot.openPopup();
  document.body.classList.remove('sb-open');
}

function fitEvent(ev) {
  if (!ev.spots.length) return;
  let b = null;
  for (const sp of ev.spots) {
    const sb = L.latLng(sp.lat, sp.lng).toBounds(sp.radius * 2);
    b = b ? b.extend(sb) : sb;
  }
  map.fitBounds(b, { padding: [20, 20], maxZoom: 17 });
  document.body.classList.remove('sb-open');
}

// ---------- サイドバー ----------
function renderSidebar() {
  const list = $('event-list');
  list.replaceChildren();
  $('empty-msg').hidden = data.events.length > 0;

  for (const ev of data.events) {
    const vis = isVisible(ev);
    const done = ev.spots.filter(isCleared).length;
    const open = !!expanded[ev.id];

    const head = el('div', { class: 'event-head' },
      el('input', {
        type: 'checkbox', checked: vis, title: '地図に表示',
        onchange: (e) => { visibility[ev.id] = e.target.checked; store(LS.visibility, visibility); refresh(); },
      }),
      el('span', { class: 'swatch', style: `background:${ev.color}` }),
      el('span', { class: 'event-name', title: 'このイベントのスポットを表示', onclick: () => fitEvent(ev) }, ev.name),
      el('span', { class: 'progress' }, `${done}/${ev.spots.length}`),
      el('button', {
        class: 'expander', title: 'スポット一覧',
        onclick: () => { expanded[ev.id] = !open; store(LS.expanded, expanded); renderSidebar(); },
      }, open ? '▲' : '▼'),
    );

    const card = el('div', { class: 'event-card' + (vis ? '' : ' off') }, head);

    if (open) {
      card.append(el('div', { class: 'event-meta' },
        `デフォルト半径 ${fmtRadius(ev.defaultRadius)}`,
        editMode ? el('button', { class: 'btn small', onclick: () => openSpotEditor(ev.id) }, '＋ スポット追加') : null,
        editMode ? el('button', { class: 'btn small', onclick: () => openEventDialog(ev.id) }, '編集') : null,
        editMode ? el('button', { class: 'btn small danger', onclick: () => deleteEvent(ev.id) }, '削除') : null,
      ));
      const ul = el('ul', { class: 'spot-list' });
      for (const sp of ev.spots) {
        const c = isCleared(sp);
        ul.append(el('li', { class: c ? 'cleared' : '' },
          el('span', { class: 'spot-name', onclick: () => focusSpot(ev, sp) }, sp.name),
          el('span', { class: 'spot-r' }, fmtRadius(sp.radius)),
          el('label', { class: 'clear-chk', title: '攻略済' },
            el('input', { type: 'checkbox', checked: c, onchange: () => toggleCleared(sp.id) }), '攻略済'),
          editMode ? el('button', { class: 'btn small', title: '編集', onclick: () => openSpotEditor(ev.id, sp.id) }, '✎') : null,
          editMode ? el('button', { class: 'btn small danger', title: '削除', onclick: () => deleteSpot(ev.id, sp.id) }, '🗑') : null,
        ));
      }
      if (!ev.spots.length) ul.append(el('li', { class: 'muted small' }, 'スポットがありません'));
      card.append(ul);
    }
    list.append(card);
  }
}

function refresh() {
  renderMap();
  renderSidebar();
}

function toggleCleared(spotId) {
  if (cleared[spotId]) delete cleared[spotId];
  else cleared[spotId] = true;
  store(LS.cleared, cleared);
  refresh();
}

// ---------- 保存（ローカルサーバーのみ） ----------
async function save() {
  try {
    const res = await fetch('api/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || res.statusText);
    toast('保存しました（公開サイトへの反映は「アップロード」ボタンで）');
    refreshPublishState();
    return true;
  } catch (e) {
    toast('保存に失敗しました: ' + e.message, true);
    return false;
  }
}

// ---------- 公開サイト（GitHub Pages）へのアップロード ----------
async function refreshPublishState() {
  const state = $('publish-state'), btn = $('btn-publish'), link = $('publish-link');
  try {
    const s = await (await fetch('api/publish', { cache: 'no-store' })).json();
    if (!s.available) {
      state.textContent = s.reason; state.className = 'small muted'; btn.disabled = true;
      return;
    }
    btn.disabled = false;
    state.textContent = s.pending ? '未アップロードの変更あり' : '公開サイトは最新です';
    state.className = 'small ' + (s.pending ? 'pending' : 'muted');
    if (s.url) { link.href = s.url; link.hidden = false; }
  } catch {
    state.textContent = '公開状態を取得できません'; state.className = 'small muted';
  }
}

$('btn-publish').addEventListener('click', async () => {
  const btn = $('btn-publish');
  if (!confirm('現在のデータを公開サイトへアップロードしますか？')) return;
  btn.disabled = true;
  btn.textContent = 'アップロード中…';
  try {
    const res = await fetch('api/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || res.statusText);
    toast('アップロードしました。公開サイトへの反映には 1〜2 分かかります');
  } catch (e) {
    alert('アップロードに失敗しました:\n' + e.message);
  } finally {
    btn.textContent = '公開サイトへアップロード';
    refreshPublishState();
  }
});

// ---------- イベント編集 ----------
let editingEventId = null;

function openEventDialog(eventId = null) {
  editingEventId = eventId;
  const ev = eventId ? findEvent(eventId) : null;
  $('event-dialog-title').textContent = ev ? 'イベント編集' : 'イベント追加';
  $('event-name').value = ev ? ev.name : '';
  $('event-radius').value = ev ? ev.defaultRadius : 200;
  $('event-color').value = ev ? ev.color : PALETTE[data.events.length % PALETTE.length];
  $('event-dialog').showModal();
  $('event-name').focus();
}

$('event-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('event-name').value.trim();
  const defaultRadius = Number($('event-radius').value);
  const color = $('event-color').value;
  if (!name || !(defaultRadius > 0)) return;
  if (editingEventId) {
    Object.assign(findEvent(editingEventId), { name, defaultRadius, color });
  } else {
    const ev = { id: newId('e'), name, defaultRadius, color, spots: [] };
    data.events.push(ev);
    expanded[ev.id] = true;
    store(LS.expanded, expanded);
  }
  $('event-dialog').close();
  refresh();
  await save();
});
$('event-cancel').addEventListener('click', () => $('event-dialog').close());

async function deleteEvent(eventId) {
  const ev = findEvent(eventId);
  if (!confirm(`イベント「${ev.name}」とそのスポット ${ev.spots.length} 件を削除しますか？`)) return;
  data.events = data.events.filter((e) => e.id !== eventId);
  refresh();
  await save();
}

async function deleteSpot(eventId, spotId) {
  const ev = findEvent(eventId);
  const sp = ev.spots.find((s) => s.id === spotId);
  if (!confirm(`スポット「${sp.name}」を削除しますか？`)) return;
  ev.spots = ev.spots.filter((s) => s.id !== spotId);
  refresh();
  await save();
}

// ---------- スポット編集 ----------
let spotEdit = null; // { eventId, spotId, lat, lng }
let tempMarker = null;
let tempCircle = null;

function openSpotEditor(eventId, spotId = null) {
  // 前回のプレビュー（マーカー・円）が残らないように消しておく
  if (tempMarker) { tempMarker.remove(); tempMarker = null; }
  if (tempCircle) { tempCircle.remove(); tempCircle = null; }
  const ev = findEvent(eventId);
  const sp = spotId ? ev.spots.find((s) => s.id === spotId) : null;
  spotEdit = { eventId, spotId, lat: sp?.lat ?? null, lng: sp?.lng ?? null };
  $('spot-panel-title').textContent = sp ? 'スポット編集' : 'スポット追加';
  $('spot-save-next').hidden = !!sp; // 「続けて追加」は新規追加のときだけ
  $('spot-panel-event').textContent = ev.name;
  $('spot-name').value = sp ? sp.name : '';
  setRadiusUI(sp ? sp.radius : ev.defaultRadius);
  $('search-q').value = '';
  $('search-results').replaceChildren();
  $('spot-panel').hidden = false;
  document.body.classList.remove('sb-open');
  updateTemp();
  if (sp) map.setView([sp.lat, sp.lng], Math.max(map.getZoom(), 16));
  $('search-q').focus();
}

function closeSpotEditor() {
  spotEdit = null;
  $('spot-panel').hidden = true;
  if (tempMarker) { tempMarker.remove(); tempMarker = null; }
  if (tempCircle) { tempCircle.remove(); tempCircle = null; }
}

function updateTemp() {
  if (!spotEdit || spotEdit.lat == null) {
    $('spot-coord').textContent = '未指定';
    return;
  }
  const ll = [spotEdit.lat, spotEdit.lng];
  const radius = Number($('spot-radius').value) || 0;
  const color = findEvent(spotEdit.eventId).color;
  $('spot-coord').textContent = `${spotEdit.lat.toFixed(6)}, ${spotEdit.lng.toFixed(6)}`;
  if (!tempMarker) {
    tempMarker = L.marker(ll, { draggable: true, zIndexOffset: 1000 }).addTo(map);
    tempMarker.on('drag', () => {
      const p = tempMarker.getLatLng();
      spotEdit.lat = p.lat; spotEdit.lng = p.lng;
      updateTemp();
    });
    tempCircle = L.circle(ll, { radius, color, weight: 3, dashArray: '4 4', fillOpacity: 0.2, interactive: false }).addTo(map);
  } else {
    tempMarker.setLatLng(ll);
    tempCircle.setLatLng(ll).setRadius(radius).setStyle({ color });
  }
}

function setSpotLocation(lat, lng, name) {
  if (!spotEdit) return;
  spotEdit.lat = lat; spotEdit.lng = lng;
  if (name && !$('spot-name').value.trim()) $('spot-name').value = name;
  updateTemp();
}

map.on('click', (e) => {
  if (!spotEdit) return;
  setSpotLocation(e.latlng.lat, e.latlng.lng);
});
$('spot-radius').addEventListener('input', updateTemp);

// 半径の選択（プリセット or カスタム）。実際の値は常に #spot-radius に入れる
const RADIUS_PRESETS = [50, 200, 1000, 5000, 10000];

function setRadiusUI(r) {
  const preset = RADIUS_PRESETS.includes(Number(r)) ? String(r) : 'custom';
  for (const rb of document.querySelectorAll('input[name=radius-preset]')) rb.checked = rb.value === preset;
  $('spot-radius').value = r;
  $('radius-custom').hidden = preset !== 'custom';
}

for (const rb of document.querySelectorAll('input[name=radius-preset]')) {
  rb.addEventListener('change', () => {
    if (rb.value === 'custom') {
      $('radius-custom').hidden = false;
      $('spot-radius').focus();
      $('spot-radius').select();
    } else {
      $('radius-custom').hidden = true;
      $('spot-radius').value = rb.value;
    }
    updateTemp();
  });
}
$('spot-cancel').addEventListener('click', closeSpotEditor);
$('spot-cancel-x').addEventListener('click', closeSpotEditor);

// ---------- 場所の検索 ----------
// 入力は次のどれでも可:
//   ・座標「34.9395, 133.1176」（Google マップで地点を右クリック → 座標をクリックでコピー）
//   ・Google マップの URL / 共有リンク（maps.app.goo.gl はローカルサーバーで展開）
//   ・名称（Nominatim / Photon / 国土地理院 を同時に検索して結果をまとめる）

function parseCoords(text) {
  const m = text.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,，\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

function parseGoogleMapsUrl(url) {
  let name = null;
  const pm = url.match(/\/maps\/place\/([^/@?]+)/);
  if (pm) { try { name = decodeURIComponent(pm[1].replace(/\+/g, ' ')); } catch { /* ignore */ } }
  // !3d<lat>!4d<lng> が地点そのもの。無ければ @lat,lng（表示中心）や q=lat,lng を使う
  const m = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/)
    || url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)
    || url.match(/[?&](?:q|query|ll|center|destination)=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/i);
  return m ? { lat: Number(m[1]), lng: Number(m[2]), name } : null;
}

async function resolveShortUrl(url) {
  const res = await fetch('api/resolve-url', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j.url;
}

// 種別の判定（駅 / バス停 / 地名 など）
// stop（停車位置）や subway_entrance（出入口）はホーム番号などの名前が付くので駅扱いしない
const STATION_VALUES = new Set(['station', 'halt', 'tram_stop']);
function kindOf(key, value) {
  if ((key === 'railway' && STATION_VALUES.has(value)) || (key === 'public_transport' && value === 'station')
      || (key === 'building' && value === 'train_station')) return '駅';
  if (key === 'highway' && value === 'bus_stop') return 'バス停';
  if (key === 'place' || key === 'boundary') return '地名';
  return null;
}
// OSM は駅を「東城」のように「駅」なしで登録しているので、駅のときは「駅」を補う
const stationName = (name, kind) => (kind === '駅' && !/駅$/.test(name) ? name + '駅' : name);

async function searchNominatim(q) {
  const b = map.getBounds();
  const params = new URLSearchParams({
    q, format: 'jsonv2', limit: '20', 'accept-language': 'ja', countrycodes: 'jp',
    viewbox: [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].join(','),
  });
  const res = await fetch('https://nominatim.openstreetmap.org/search?' + params);
  if (!res.ok) throw new Error('Nominatim ' + res.status);
  return (await res.json()).map((r) => {
    const kind = kindOf(r.category, r.type);
    return {
      src: 'OSM', kind, lat: Number(r.lat), lng: Number(r.lon),
      name: stationName(r.name || r.display_name.split(',')[0], kind), detail: r.display_name,
    };
  });
}

async function searchPhoton(q) {
  const c = map.getCenter();
  // bbox で日本周辺に限定、lat/lon で表示中の地図の近くを優先
  const params = new URLSearchParams({ q, limit: '20', lat: c.lat, lon: c.lng, bbox: '122,20,154,46' });
  const res = await fetch('https://photon.komoot.io/api/?' + params);
  if (!res.ok) throw new Error('Photon ' + res.status);
  return (await res.json()).features.map((f) => {
    const p = f.properties;
    const kind = kindOf(p.osm_key, p.osm_value);
    return {
      src: 'Photon', kind, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0],
      name: stationName(p.name || p.street || '(名称なし)', kind),
      detail: [p.state, p.county, p.city, p.district, p.street, p.housenumber].filter(Boolean).join(' '),
    };
  });
}

async function searchGsi(q) {
  const res = await fetch('https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(q));
  if (!res.ok) throw new Error('国土地理院 ' + res.status);
  return (await res.json()).map((r) => {
    const t = r.properties.title;
    return {
      src: '地理院', kind: /駅$/.test(t) ? '駅' : '地名',
      lat: r.geometry.coordinates[1], lng: r.geometry.coordinates[0], name: t, detail: t,
    };
  });
}

// ---------- 検索結果の並べ替え ----------
// 名前の一致度で点数を付ける。「駅」の有無・全角半角・空白の違いは無視して比較する
const norm = (s) => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const baseName = (s) => norm(s).replace(/駅$/, '');

function scoreResult(r, q) {
  const qb = baseName(q), nb = baseName(r.name);
  const wantsStation = /駅$/.test(q.trim());
  let s;
  if (nb === qb) s = 100;                 // 完全一致
  else if (nb.startsWith(qb)) s = 60;     // 前方一致
  else if (nb.endsWith(qb)) s = 50;       // 後方一致（例: 備後庄原 ← 庄原）
  else if (nb.includes(qb)) s = 30;       // 部分一致（例: 広島県庄原市）
  else s = 0;                             // 表記ゆれなど
  if (r.kind === '駅') s += wantsStation ? 40 : 10;
  if (r.kind === 'バス停' && wantsStation) s -= 40;
  return s;
}

function rankResults(results, q) {
  const c = map.getCenter();
  for (const r of results) {
    r.score = scoreResult(r, q);
    r.dist = map.distance(c, [r.lat, r.lng]);
  }
  // 点数が高い順、同点なら今見ている地図の中心に近い順
  results.sort((a, b) => b.score - a.score || a.dist - b.dist);
  const out = [];
  for (const r of results) {
    // 同じ名前で近いもの（駅は路線・データ元ごとに位置がずれるので 1km、それ以外は 50m）は重複として除外
    const dup = out.some((m) => baseName(m.name) === baseName(r.name)
      && map.distance([m.lat, m.lng], [r.lat, r.lng]) < (r.kind === '駅' || m.kind === '駅' ? 1000 : 50));
    if (!dup) out.push(r);
  }
  return out.slice(0, 30);
}

const fmtDist = (m) => (m >= 1000 ? `${Math.round(m / 1000)}km` : `${Math.round(m)}m`);

function showResults(results, emptyMsg) {
  const ul = $('search-results');
  ul.replaceChildren();
  if (!results.length) { ul.append(el('li', { class: 'muted' }, emptyMsg)); return; }
  for (const r of results) {
    const li = el('li', {
      onclick: () => {
        ul.querySelectorAll('li').forEach((x) => x.classList.remove('sel'));
        li.classList.add('sel');
        $('spot-name').value = r.name;
        setSpotLocation(r.lat, r.lng);
        map.setView([r.lat, r.lng], Math.max(map.getZoom(), 16));
      },
    },
    el('b', {}, r.name,
      r.kind ? el('span', { class: 'kind' + (r.kind === '駅' ? ' station' : '') }, r.kind) : null,
      el('span', { class: 'src' }, r.src)),
    r.detail,
    el('span', { class: 'dist' }, `（地図の中心から ${fmtDist(r.dist)}）`));
    ul.append(li);
  }
}

function placeDirect(lat, lng, name) {
  $('search-results').replaceChildren(el('li', { class: 'muted' }, '指定した座標に配置しました'));
  if (name) $('spot-name').value = name;
  setSpotLocation(lat, lng);
  map.setView([lat, lng], Math.max(map.getZoom(), 16));
}

$('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('search-q').value.trim();
  if (!q) return;
  const ul = $('search-results');

  // 座標
  const c = parseCoords(q);
  if (c) { placeDirect(c.lat, c.lng); return; }

  // Google マップの URL
  if (/^https?:\/\//i.test(q)) {
    ul.replaceChildren(el('li', { class: 'muted' }, 'URL を解析中…'));
    try {
      let url = q;
      if (!parseGoogleMapsUrl(url) && /(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)/i.test(url)) {
        url = await resolveShortUrl(url);
      }
      const g = parseGoogleMapsUrl(url);
      if (!g) throw new Error('この URL から座標を読み取れませんでした');
      placeDirect(g.lat, g.lng, g.name);
    } catch (err) {
      ul.replaceChildren(el('li', { class: 'muted' }, err.message));
    }
    return;
  }

  // 名称検索（3 サービスを並列に）→ 一致度順に並べ替え
  ul.replaceChildren(el('li', { class: 'muted' }, '検索中…'));
  const settled = await Promise.allSettled([searchGsi(q), searchNominatim(q), searchPhoton(q)]);
  const all = settled.filter((s) => s.status === 'fulfilled').flatMap((s) => s.value);
  const failed = settled.filter((s) => s.status === 'rejected').map((s) => s.reason.message);
  showResults(rankResults(all, q), '見つかりませんでした。Google マップで地点を右クリック → 座標をコピーして貼り付けるか、地図をクリックして指定してください');
  if (failed.length) ul.append(el('li', { class: 'muted' }, '一部の検索に失敗: ' + failed.join(', ')));
});

$('spot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!spotEdit) return;
  if (spotEdit.lat == null) { toast('場所を指定してください（検索結果を選択 or 地図をクリック）', true); return; }
  const name = $('spot-name').value.trim();
  const radius = Number($('spot-radius').value);
  if (!name || !(radius > 0)) return;
  const ev = findEvent(spotEdit.eventId);
  const vals = { name, radius, lat: +spotEdit.lat.toFixed(7), lng: +spotEdit.lng.toFixed(7) };
  if (spotEdit.spotId) {
    Object.assign(ev.spots.find((s) => s.id === spotEdit.spotId), vals);
  } else {
    ev.spots.push({ id: newId('s'), ...vals });
  }
  expanded[ev.id] = true;
  store(LS.expanded, expanded);
  // 「続けて追加」なら同じイベントで入力欄を空にして開き直す（地図の位置はそのまま）
  const next = e.submitter?.id === 'spot-save-next' && !spotEdit.spotId;
  if (next) openSpotEditor(ev.id);
  else closeSpotEditor();
  refresh();
  if (await save() && next) toast(`「${name}」を保存しました。続けて次のスポットを入力できます`);
});

// ---------- その他 UI ----------
$('btn-add-event').addEventListener('click', () => openEventDialog());
$('sb-open').addEventListener('click', () => document.body.classList.add('sb-open'));
$('sb-close').addEventListener('click', () => document.body.classList.remove('sb-open'));

for (const [id, key] of [['opt-labels', 'labels'], ['opt-hide-cleared', 'hideCleared']]) {
  $(id).checked = options[key];
  $(id).addEventListener('change', (e) => { options[key] = e.target.checked; store(LS.options, options); renderMap(); });
}

let locMarker = null;
$('btn-locate').addEventListener('click', () => {
  if (!navigator.geolocation) { toast('このブラウザは位置情報に対応していません', true); return; }
  navigator.geolocation.getCurrentPosition(
    (p) => {
      const ll = [p.coords.latitude, p.coords.longitude];
      if (locMarker) locMarker.setLatLng(ll);
      else locMarker = L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#1976d2', fillOpacity: 1 }).addTo(map);
      map.setView(ll, Math.max(map.getZoom(), 16));
    },
    (err) => toast('現在地を取得できませんでした: ' + err.message, true),
    { enableHighAccuracy: true, timeout: 10000 },
  );
});

// ---------- 起動 ----------
async function init() {
  // ローカルサーバー（server.py）経由なら編集モード。?view を付けると閲覧モードで確認できる
  if (!new URLSearchParams(location.search).has('view')) {
    try {
      const r = await fetch('api/status', { cache: 'no-store' });
      editMode = r.ok && (await r.json()).edit === true;
    } catch { editMode = false; }
  }
  document.body.classList.toggle('editing', editMode);
  $('mode-badge').textContent = editMode ? '編集モード' : '閲覧モード';
  $('mode-badge').classList.toggle('edit', editMode);
  if (editMode) refreshPublishState();

  try {
    const r = await fetch('data/events.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    data = await r.json();
    data.events ??= [];
  } catch (e) {
    toast('データの読み込みに失敗しました', true);
  }

  const view = load(LS.view, null);
  const all = data.events.flatMap((e) => e.spots);
  if (view) map.setView([view.lat, view.lng], view.z);
  else if (all.length) map.fitBounds(L.latLngBounds(all.map((s) => [s.lat, s.lng])), { padding: [30, 30], maxZoom: 16 });
  else map.setView([35.681236, 139.767125], 13); // 東京駅

  refresh();
}
init();
