'use strict';
// ============================================================================
// scenery.js  --  background pictures per table and screen type, and the Kunukku pictures,
// managed from the admin panel (no redeploy).
//
// BACKGROUNDS. Three tables (4-player, 6-player, 56) x three screen types:
//     portrait   phone (or tablet) held upright
//     landscape  phone held sideways
//     desktop    computer / big tablet sideways
// For each one the admin can ADD a picture, REPLACE it, or DELETE it (= back to the original
// the game ships with; for 56, which ships with no picture, back to the plain dark table).
// The admin page frames the picture for that screen shape and bakes the result, so the page
// only needs "fill the screen, centred" -- see /scenery.css below.
//
// KUNUKKU. The sad-coconut pictures can be replaced the same way (served under the SAME url as
// the original, so no page changes). The coconut is only ever shown/hidden by the game through a
// CSS class, so swapping the picture cannot interfere with it appearing and disappearing.
//
// The server never decodes pixels; it checks the file header only (real PNG / WebP / JPEG, sane size).
// ============================================================================
const fs = require('fs');
const path = require('path');

const TABLES = ['4p', '6p', '56'];
const SLOTS = ['portrait', 'landscape', 'desktop'];
const MEDIA = {
  portrait: '(orientation: portrait)',
  landscape: '(orientation: landscape) and (max-height: 520px)',
  desktop: '(orientation: landscape) and (min-height: 521px)',
};
// Which element carries each table's background on each screen type TODAY (measured on the live pages).
// The generated rule uses extra specificity + !important so it beats the page's own rules.
const TARGETS = {
  '4p': { portrait: ['html body .table:not(.mode6)'], landscape: ['html body.k28-in-game', 'html body.k28-in-game .game-wrap'], desktop: ['html body.k28-in-game', 'html body.k28-in-game .game-wrap'] },
  '6p': { portrait: ['html body #gameScreen'], landscape: ['html body.k28-in-game', 'html body.k28-in-game #gameScreen'], desktop: ['html body.k28-in-game', 'html body.k28-in-game #gameScreen'] },
  '56': { portrait: ['html body'], landscape: ['html body'], desktop: ['html body'] },
};
// What the picture's frame should be (the admin editor bakes to exactly this shape and size).
const FRAMES = { portrait: { w: 900, h: 1600 }, landscape: { w: 1600, h: 740 }, desktop: { w: 1920, h: 1080 } };
// What each slot shows today when nothing has been uploaded (for the admin thumbnails).
const ORIGINALS = {
  '4p': { portrait: '/images/table-bg-4p.jpg', landscape: '/images/desktop-bg-4p.jpg', desktop: '/images/desktop-bg-4p.jpg' },
  '6p': { portrait: '/images/table-bg-6p.jpg', landscape: '/images/desktop-bg-6p.jpg', desktop: '/images/desktop-bg-6p.jpg' },
  '56': { portrait: null, landscape: null, desktop: null },
};
const KUNUKKU = {
  coconut: { url: '/images/kunukku/sad-coconut.png', label: 'Sad coconut (shown on a shut-out player)', aspect: 845 / 1101 },
  icon: { url: '/images/kunukku/sad-coconut-face-icon.png', label: 'Coconut face icon (welcome screen)', aspect: 390 / 560 },
};
const MAX_BG_BYTES = 1200 * 1024, MAX_KUNUKKU_BYTES = 400 * 1024;
const mimeExt = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' };

// ---- header inspection: PNG / WebP / JPEG, returns { ok, mime, ext, width, height, alpha } --------------
function inspect(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32) return { ok: false, error: 'That does not look like an image file.' };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (buf.toString('ascii', 12, 16) !== 'IHDR') return { ok: false, error: 'Damaged PNG file.' };
    const ct = buf[25];
    return { ok: true, mime: 'image/png', ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), alpha: ct === 4 || ct === 6 };
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const f = buf.toString('ascii', 12, 16);
    if (f === 'VP8X') return { ok: true, mime: 'image/webp', ext: 'webp', width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)), height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)), alpha: !!(buf[20] & 0x10) };
    if (f === 'VP8L' && buf[20] === 0x2f) { const b1 = buf[21], b2 = buf[22], b3 = buf[23], b4 = buf[24]; return { ok: true, mime: 'image/webp', ext: 'webp', width: 1 + (((b2 & 0x3f) << 8) | b1), height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)), alpha: !!((b4 >> 4) & 1) }; }
    if (f === 'VP8 ') {                          // lossy: width/height are in the frame header after the 3-byte tag + 3-byte start code
      const w = buf.readUInt16LE(26) & 0x3fff, h = buf.readUInt16LE(28) & 0x3fff;
      return { ok: true, mime: 'image/webp', ext: 'webp', width: w, height: h, alpha: false };
    }
    return { ok: false, error: 'Unsupported WebP variant.' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {      // JPEG: walk the markers to the first start-of-frame
    let p = 2;
    while (p + 9 < buf.length) {
      if (buf[p] !== 0xff) { p++; continue; }
      const m = buf[p + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { ok: true, mime: 'image/jpeg', ext: 'jpg', height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7), alpha: false };
      p += 2 + buf.readUInt16BE(p + 2);
    }
    return { ok: false, error: 'Damaged JPEG file.' };
  }
  return { ok: false, error: 'Only PNG, WebP or JPEG pictures are accepted.' };
}

function createScenery(opts) {
  const dataDir = opts.dataDir;
  const file = path.join(dataDir, 'scenery.json');
  const dir = path.join(dataDir, 'scenery');
  let state = { rev: 1, bg: {}, kunukku: {} };       // bg['4p:portrait'] = { file, mime, bytes, w, h, at }

  function load() {
    try {
      if (fs.existsSync(file)) {
        const p = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (p && typeof p === 'object') { state.rev = Math.max(1, Number(p.rev) || 1); state.bg = p.bg || {}; state.kunukku = p.kunukku || {}; }
      }
    } catch (e) { console.error('[scenery] could not read the saved list, starting empty:', e.message); }
    for (const grp of ['bg', 'kunukku']) for (const k of Object.keys(state[grp])) {   // a vanished file (volume reset) is dropped
      try { if (!fs.existsSync(path.join(dir, state[grp][k].file))) delete state[grp][k]; } catch (_) {}
    }
  }
  function save() { try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(state)); } catch (e) { console.error('[scenery] could not save:', e.message); } }
  const decode = (data) => { try { return Buffer.from(String(data || '').replace(/^data:[^,]*,/, ''), 'base64'); } catch (_) { return null; } };
  const slotKey = (t, s) => t + ':' + s;
  function removeFile(rec) { if (rec) { try { fs.unlinkSync(path.join(dir, rec.file)); } catch (_) {} } }

  // ---- backgrounds ----------------------------------------------------------------------------------
  function setBackground(table, slot, b) {
    if (!TABLES.includes(table) || !SLOTS.includes(slot)) return { ok: false, status: 400, error: 'Unknown table or screen type.' };
    const buf = decode(b && b.data);
    if (!buf || !buf.length) return { ok: false, status: 400, error: 'No picture received.' };
    if (buf.length > MAX_BG_BYTES) return { ok: false, status: 413, error: 'Picture is too big (limit ' + Math.round(MAX_BG_BYTES / 1024) + ' KB). Lower the quality or size in the editor.' };
    const info = inspect(buf);
    if (!info.ok) return { ok: false, status: 400, error: info.error };
    if (info.width && (info.width < 300 || info.height < 300 || info.width > 4096 || info.height > 4096)) return { ok: false, status: 400, error: 'Picture size must be between 300 and 4096 pixels.' };
    const key = slotKey(table, slot);
    const fname = table + '-' + slot + '-' + Date.now().toString(36) + '.' + info.ext;     // a new name per upload, so browsers never show a stale one
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, fname), buf); }
    catch (e) { return { ok: false, status: 500, error: 'Could not store the picture on the server.' }; }
    removeFile(state.bg[key]);
    state.bg[key] = { file: fname, mime: info.mime, bytes: buf.length, w: info.width, h: info.height, at: Date.now() };
    state.rev += 1; save();
    return { ok: true, status: 200, slot: describe(table, slot) };
  }
  function clearBackground(table, slot) {
    const key = slotKey(table, slot);
    if (!state.bg[key]) return { ok: false, status: 404, error: 'There is no custom picture to delete here.' };
    removeFile(state.bg[key]); delete state.bg[key]; state.rev += 1; save();
    return { ok: true, status: 200 };
  }
  function describe(table, slot) {
    const rec = state.bg[slotKey(table, slot)];
    return {
      table, slot, frame: FRAMES[slot], original: ORIGINALS[table][slot],
      custom: rec ? { url: '/scenery/' + rec.file, bytes: rec.bytes, w: rec.w, h: rec.h, at: rec.at, mime: rec.mime } : null,
    };
  }
  function listBackgrounds() { const out = []; for (const t of TABLES) for (const s of SLOTS) out.push(describe(t, s)); return out; }

  // The stylesheet every table page loads LAST. Empty when nothing is customised.
  function css() {
    let out = '';
    for (const s of SLOTS) {
      let body = '';
      for (const t of TABLES) {
        const rec = state.bg[slotKey(t, s)]; if (!rec) continue;
        const url = '/scenery/' + rec.file;
        const decl = `background-image:url('${url}') !important;background-size:cover !important;background-position:center center !important;background-repeat:no-repeat !important;background-color:#05070a !important;`;
        // 6-player portrait keeps the soft dark band behind the score bar that the original rule had
        const decl6 = t === '6p' && s === 'portrait'
          ? `background-image:linear-gradient(to bottom,rgba(0,0,0,0.75) 0%,rgba(0,0,0,0.5) 55%,rgba(0,0,0,0) 100%),url('${url}') !important;background-size:100% 10%,cover !important;background-position:top,center center !important;background-repeat:no-repeat,no-repeat !important;background-color:#05070a !important;`
          : decl;
        // each table's rules only apply on that table's page: the page marks its <html> with data-table via the link's query
        body += TARGETS[t][s].map((sel) => `html[data-scenery="${t}"] ${sel.replace(/^html /, '')}{${decl6}}\n`).join('');
      }
      if (body) out += `@media ${MEDIA[s]}{\n${body}}\n`;
    }
    return out ? '/* Generated from the admin Scenery tab. */\n' + out : '';
  }

  // ---- Kunukku pictures -----------------------------------------------------------------------------------
  function setKunukku(which, b) {
    if (!KUNUKKU[which]) return { ok: false, status: 400, error: 'Unknown Kunukku picture.' };
    const buf = decode(b && b.data);
    if (!buf || !buf.length) return { ok: false, status: 400, error: 'No picture received.' };
    if (buf.length > MAX_KUNUKKU_BYTES) return { ok: false, status: 413, error: 'Picture is too big (limit ' + Math.round(MAX_KUNUKKU_BYTES / 1024) + ' KB).' };
    const info = inspect(buf);
    if (!info.ok) return { ok: false, status: 400, error: info.error };
    if (!info.alpha) return { ok: false, status: 400, error: 'The Kunukku picture needs a transparent background.' };
    if (info.width && (info.width < 64 || info.height < 64 || info.width > 2048 || info.height > 2048)) return { ok: false, status: 400, error: 'Picture size must be between 64 and 2048 pixels.' };
    const fname = 'kunukku-' + which + '-' + Date.now().toString(36) + '.' + info.ext;
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, fname), buf); }
    catch (e) { return { ok: false, status: 500, error: 'Could not store the picture on the server.' }; }
    removeFile(state.kunukku[which]);
    state.kunukku[which] = { file: fname, mime: info.mime, bytes: buf.length, w: info.width, h: info.height, at: Date.now() };
    state.rev += 1; save();
    return { ok: true, status: 200 };
  }
  function clearKunukku(which) {
    if (!state.kunukku[which]) return { ok: false, status: 404, error: 'There is no custom picture to delete here.' };
    removeFile(state.kunukku[which]); delete state.kunukku[which]; state.rev += 1; save();
    return { ok: true, status: 200 };
  }
  function listKunukku() {
    return Object.keys(KUNUKKU).map((k) => { const r = state.kunukku[k]; return { which: k, label: KUNUKKU[k].label, url: KUNUKKU[k].url, aspect: KUNUKKU[k].aspect, custom: r ? { bytes: r.bytes, w: r.w, h: r.h, at: r.at } : null }; });
  }
  // for the web route that answers /images/kunukku/<original>.png with the replacement
  function kunukkuFileForUrl(urlPath) {
    for (const k of Object.keys(KUNUKKU)) if (KUNUKKU[k].url === urlPath && state.kunukku[k]) return { path: path.join(dir, state.kunukku[k].file), mime: state.kunukku[k].mime, at: state.kunukku[k].at };
    return null;
  }
  function fileByName(name) {
    if (!/^[a-z0-9-]+\.(png|webp|jpg)$/i.test(name)) return null;
    const full = path.join(dir, name);
    if (!full.startsWith(dir + path.sep) || !fs.existsSync(full)) return null;
    const ext = name.split('.').pop().toLowerCase();
    return { path: full, mime: ext === 'jpg' ? 'image/jpeg' : 'image/' + ext };
  }
  load();
  return { setBackground, clearBackground, listBackgrounds, css, setKunukku, clearKunukku, listKunukku, kunukkuFileForUrl, fileByName, rev: () => state.rev, _state: () => state };
}

module.exports = { createScenery, inspect, TABLES, SLOTS, FRAMES, TARGETS, MEDIA, KUNUKKU };
