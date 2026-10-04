'use strict';
// ============================================================================
// avatar-catalog.js  --  the managed list of avatars (add / delete from the admin
// panel, no redeploy).
//
// BEFORE: the avatar list (toon1..toon90) was written into eight files. Adding or
// deleting one meant editing code and redeploying.
//
// NOW: the server keeps ONE catalog on the data volume and tells every page what is
// in it (via /avatar-catalog.js, loaded before the page's own scripts):
//
//   * BUILT-IN avatars  toon1..toon90 -- files shipped with the site. "Deleting" one
//     hides it (it cannot be removed from the deployed files); "Restore" brings it back.
//   * UPLOADED avatars  toon1001, toon1002, ... -- stored on the data volume
//     (DATA_DIR/uploaded-avatars). Deleting one really deletes the file. Keys are
//     never reused, so a deleted number can't later show somebody else's picture.
//   * PERSONAL avatars  toon101..toon106 -- protected, never listed, never deleted.
//
// Each avatar has a gender (m / f) so bots keep matching faces, and an upload can be
// given to one bot NAME ("Meera always uses this face").
//
// Uploaded pictures must already be transparent cut-outs (the admin page prepares them
// in the browser: optional plain-background removal, crop, 320x320, WebP or PNG). The
// server never decodes pixels; it only checks the file header: real PNG/WebP, has an
// alpha channel, sensible size.
// ============================================================================
const fs = require('fs');
const path = require('path');

const BUILTIN_COUNT = 90;
const PERSONAL = ['toon101', 'toon102', 'toon103', 'toon104', 'toon105', 'toon106'];
const BUILTIN_MALE = [1, 5, 8, 19, 24, 26, 27, 34, 39, 43, 45, 48, 58, 62, 63, 66, 74, 80];
const FIRST_UPLOAD_ID = 1001;
const MAX_UPLOADED = 300;
const MAX_BYTES = 250 * 1024;
const MIN_PER_GENDER = 10;           // never let deleting leave a gender with fewer faces than this
const MIN_SIDE = 96, MAX_SIDE = 1024;

const keyOfNum = (n) => 'toon' + n;
const numOfKey = (k) => { const m = /^toon(\d+)$/.exec(String(k || '')); return m ? Number(m[1]) : null; };

// ---- image header checks (no pixel decoding) ------------------------------------------
// returns { ok, ext, mime, width, height } or { ok:false, error }
function inspectImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32) return { ok: false, error: 'That does not look like an image file.' };
  // PNG
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (buf.toString('ascii', 12, 16) !== 'IHDR') return { ok: false, error: 'Damaged PNG file.' };
    const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20), colorType = buf[25];
    let alpha = colorType === 4 || colorType === 6;
    if (colorType === 3) {                         // palette PNG: transparency lives in a tRNS chunk before the pixel data
      let p = 8;
      while (p + 8 <= buf.length) {
        const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
        if (type === 'tRNS') { alpha = true; break; }
        if (type === 'IDAT' || type === 'IEND') break;
        p += 12 + len;
      }
    }
    return { ok: true, ext: 'png', mime: 'image/png', width, height, alpha };
  }
  // WebP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = buf.toString('ascii', 12, 16);
    if (fourcc === 'VP8X') {
      const flags = buf[20];
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)), height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { ok: true, ext: 'webp', mime: 'image/webp', width, height, alpha: !!(flags & 0x10) };
    }
    if (fourcc === 'VP8L' && buf[20] === 0x2f) {
      const b1 = buf[21], b2 = buf[22], b3 = buf[23], b4 = buf[24];
      const width = 1 + (((b2 & 0x3f) << 8) | b1), height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
      return { ok: true, ext: 'webp', mime: 'image/webp', width, height, alpha: !!((b4 >> 4) & 1) };
    }
    if (fourcc === 'VP8 ') return { ok: true, ext: 'webp', mime: 'image/webp', width: 0, height: 0, alpha: false };
    return { ok: false, error: 'Unsupported WebP variant.' };
  }
  return { ok: false, error: 'Only PNG or WebP pictures with a transparent background are accepted (JPEG cannot be transparent).' };
}

function createAvatarCatalog(opts) {
  const dataDir = opts.dataDir;
  const file = path.join(dataDir, 'avatar-catalog.json');
  const uploadDir = path.join(dataDir, 'uploaded-avatars');
  let state = { version: 1, nextId: FIRST_UPLOAD_ID, entries: {}, removed: {}, nameFace: {} };
  let rev = 1;                                   // bumped on every change, lets pages notice a new catalog

  function load() {
    try {
      if (fs.existsSync(file)) {
        const p = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (p && typeof p === 'object') {
          state.nextId = Math.max(FIRST_UPLOAD_ID, Number(p.nextId) || FIRST_UPLOAD_ID);
          state.entries = p.entries && typeof p.entries === 'object' ? p.entries : {};
          state.removed = p.removed && typeof p.removed === 'object' ? p.removed : {};
          state.nameFace = p.nameFace && typeof p.nameFace === 'object' ? p.nameFace : {};
        }
      }
    } catch (e) { console.error('[avatars] could not read the catalog, starting from the built-in list:', e.message); }
    // an entry whose file has vanished (volume reset) is dropped rather than shown as a broken picture
    for (const k of Object.keys(state.entries)) {
      try { if (!fs.existsSync(path.join(uploadDir, k + '.' + state.entries[k].ext))) delete state.entries[k]; } catch (_) {}
    }
    for (const [name, key] of Object.entries(state.nameFace)) if (!isActive(key)) delete state.nameFace[name];
  }
  function save() {
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(state)); }
    catch (e) { console.error('[avatars] could not save the catalog:', e.message); }
  }

  const genderOfBuiltin = (n) => (BUILTIN_MALE.includes(n) ? 'm' : 'f');
  function isBuiltinKey(k) { const n = numOfKey(k); return n != null && n >= 1 && n <= BUILTIN_COUNT; }
  function genderOf(k) { if (state.entries[k]) return state.entries[k].gender; return isBuiltinKey(k) ? genderOfBuiltin(numOfKey(k)) : null; }
  function isActive(k) {
    if (state.entries[k]) return true;
    return isBuiltinKey(k) && !state.removed[k];
  }

  // ---- what the pages need ----------------------------------------------------------
  function activeKeys() {
    const out = [];
    for (let n = 1; n <= BUILTIN_COUNT; n++) if (!state.removed[keyOfNum(n)]) out.push(keyOfNum(n));
    Object.keys(state.entries).sort((a, b) => numOfKey(a) - numOfKey(b)).forEach((k) => out.push(k));
    return out;
  }
  function clientData() {
    const keys = activeKeys();
    const genderMap = {};
    for (let n = 1; n <= BUILTIN_COUNT; n++) genderMap[keyOfNum(n)] = genderOfBuiltin(n);      // removed ones keep their gender
    for (const [k, e] of Object.entries(state.entries)) genderMap[k] = e.gender;
    return {
      rev, keys, personal: PERSONAL.slice(),
      male: keys.filter((k) => genderMap[k] === 'm'), female: keys.filter((k) => genderMap[k] === 'f'),
      genderOf: genderMap, nameFace: Object.assign({}, state.nameFace),
    };
  }
  // The script every page loads FIRST. It must never throw and never be cached.
  function clientJs() {
    return 'window.AVATAR_CATALOG=' + JSON.stringify(clientData()).replace(/</g, '\\u003c') + ';\n' +
      '(function(c){var s={};c.keys.concat(c.personal).forEach(function(k){s[k]=1});' +
      'c.has=function(k){return s[k]===1};' +
      'c.faceFor=function(name){var k=c.nameFace[name];return k&&s[k]===1?k:null};})(window.AVATAR_CATALOG);\n';
  }
  function isValidKey(k) { return typeof k === 'string' && (PERSONAL.includes(k) || isActive(k)); }

  // ---- admin operations --------------------------------------------------------------
  const countGender = (g) => activeKeys().filter((k) => genderOf(k) === g).length;
  function list() {
    const rows = [];
    for (let n = 1; n <= BUILTIN_COUNT; n++) {
      const k = keyOfNum(n);
      rows.push({ key: k, gender: genderOfBuiltin(n), source: 'builtin', removed: !!state.removed[k], names: namesFor(k) });
    }
    for (const k of Object.keys(state.entries).sort((a, b) => numOfKey(a) - numOfKey(b))) {
      const e = state.entries[k];
      rows.push({ key: k, gender: e.gender, source: 'uploaded', removed: false, label: e.label || '', bytes: e.bytes, addedAt: e.addedAt, names: namesFor(k) });
    }
    return rows;
  }
  const namesFor = (k) => Object.keys(state.nameFace).filter((n) => state.nameFace[n] === k);

  function cleanName(n) { n = String(n == null ? '' : n).replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 30); return n; }

  function add(b) {
    b = b || {};
    const gender = b.gender === 'm' || b.gender === 'f' ? b.gender : null;
    if (!gender) return { ok: false, status: 400, error: 'Choose male or female.' };
    if (Object.keys(state.entries).length >= MAX_UPLOADED) return { ok: false, status: 400, error: 'Too many uploaded avatars already.' };
    let buf;
    try { buf = Buffer.from(String(b.data || '').replace(/^data:[^,]*,/, ''), 'base64'); } catch (_) { buf = null; }
    if (!buf || !buf.length) return { ok: false, status: 400, error: 'No picture received.' };
    if (buf.length > MAX_BYTES) return { ok: false, status: 413, error: 'Picture is too big (limit ' + Math.round(MAX_BYTES / 1024) + ' KB). The admin page should have shrunk it.' };
    const info = inspectImage(buf);
    if (!info.ok) return { ok: false, status: 400, error: info.error };
    if (!info.alpha) return { ok: false, status: 400, error: 'This picture has no transparent background. Upload a cut-out (or use "remove plain background" on the admin page).' };
    if (info.width && (info.width < MIN_SIDE || info.height < MIN_SIDE || info.width > MAX_SIDE || info.height > MAX_SIDE)) {
      return { ok: false, status: 400, error: 'Picture size must be between ' + MIN_SIDE + ' and ' + MAX_SIDE + ' pixels.' };
    }
    if (info.width && Math.abs(info.width - info.height) > Math.max(2, info.width * 0.05)) return { ok: false, status: 400, error: 'Picture must be square.' };
    const key = keyOfNum(state.nextId);
    try {
      fs.mkdirSync(uploadDir, { recursive: true });
      fs.writeFileSync(path.join(uploadDir, key + '.' + info.ext), buf);
    } catch (e) { return { ok: false, status: 500, error: 'Could not store the picture on the server.' }; }
    state.nextId += 1;
    state.entries[key] = { gender, label: String(b.label || '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 40), ext: info.ext, mime: info.mime, bytes: buf.length, addedAt: Date.now() };
    const name = cleanName(b.nameFor);
    if (name) state.nameFace[name] = key;
    rev += 1; save();
    return { ok: true, status: 200, key, avatar: list().find((r) => r.key === key) };
  }
  function remove(key) {
    if (PERSONAL.includes(key)) return { ok: false, status: 400, error: 'Personal avatars are protected and cannot be deleted.' };
    if (!isActive(key)) return { ok: false, status: 404, error: 'No such avatar.' };
    const g = genderOf(key);
    if (countGender(g) - 1 < MIN_PER_GENDER) return { ok: false, status: 400, error: 'Keep at least ' + MIN_PER_GENDER + ' ' + (g === 'm' ? 'male' : 'female') + ' avatars so every table has enough different faces.' };
    if (state.entries[key]) {
      try { fs.unlinkSync(path.join(uploadDir, key + '.' + state.entries[key].ext)); } catch (_) {}
      delete state.entries[key];
    } else state.removed[key] = true;                  // built-in: hide it (the file ships with the site)
    for (const n of Object.keys(state.nameFace)) if (state.nameFace[n] === key) delete state.nameFace[n];
    rev += 1; save();
    return { ok: true, status: 200 };
  }
  function restore(key) {
    if (!isBuiltinKey(key) || !state.removed[key]) return { ok: false, status: 404, error: 'Nothing to restore.' };
    delete state.removed[key]; rev += 1; save();
    return { ok: true, status: 200 };
  }
  function setNameFace(name, key) {
    name = cleanName(name);
    if (!name) return { ok: false, status: 400, error: 'Enter a bot name.' };
    if (key) {
      if (!isActive(key)) return { ok: false, status: 400, error: 'That avatar is not available.' };
      state.nameFace[name] = key;
    } else delete state.nameFace[name];
    rev += 1; save();
    return { ok: true, status: 200 };
  }
  // an uploaded avatar's file, for the web route
  function fileFor(key) {
    const e = state.entries[key];
    return e ? { path: path.join(uploadDir, key + '.' + e.ext), mime: e.mime, ext: e.ext } : null;
  }
  load();
  return { clientData, clientJs, isValidKey, list, add, remove, restore, setNameFace, fileFor, isActive, genderOf, _state: () => state };
}

module.exports = { createAvatarCatalog, inspectImage, PERSONAL, BUILTIN_COUNT, BUILTIN_MALE, MIN_PER_GENDER };
