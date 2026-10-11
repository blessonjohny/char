'use strict';
// ============================================================================
// accounts.js -- optional player accounts for 28gulan.com
//
//   * Sign up with email + password (confirmation link emailed, no fake emails),
//     Sign in with Google, forgot-password by email.
//   * Stores ONLY: name, email, player name, avatar, a salted scrypt password hash
//     (never the password), and timestamps. Nothing else.
//   * A small cap on registered users (MAX_USERS, default 100).
//   * Player photo -> square 256px WebP (~20-40 KB) stored on the data volume.
//   * Guests are untouched: nothing here is required to play.
//
// Environment variables (all optional until you want the feature):
//   BREVO_API_KEY      Brevo (Sendinblue) transactional-email API key
//   MAIL_FROM          a sender address you verified in Brevo
//   MAIL_FROM_NAME     display name on the email (default "28 Gulan")
//   GOOGLE_CLIENT_ID   Google OAuth Web client id (Google button appears when set)
//   PUBLIC_URL         https://28gulan.com   (used in email links)
//   MAX_USERS          default 100
//   DATA_DIR           (already used by the rest of the server -- point it at the Railway Volume)
// ============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* optional: photos then need a browser that can make WebP */ }

const COOKIE = 'k28s';
const SESSION_MS = 60 * 24 * 3600 * 1000;
const VERIFY_MS = 3 * 24 * 3600 * 1000;
const RESET_MS = 60 * 60 * 1000;
const PIC_RE = /^pic_[a-f0-9]{10}$/;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cleanText = (s, n) => String(s == null ? '' : s).replace(/[<>&"'`\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"']+@[^\s@<>()[\]\\,;:"']+\.[A-Za-z]{2,}$/;

function createAccounts(opts) {
  const dataDir = opts.dataDir;
  const express = opts.express;
  const adminAuth = opts.adminAuth;                    // (req,res) => bool
  const nameBad = opts.nameBad || (() => false);       // profanity filter
  const avatarOk = opts.avatarOk || (() => false);     // is this a real catalog avatar key
  const log = opts.log || console.log;

  const env = () => process.env;
  const MAX_USERS = () => Math.max(1, parseInt(env().MAX_USERS, 10) || 100);
  const PUBLIC_URL = () => (env().PUBLIC_URL || 'https://28gulan.com').replace(/\/+$/, '');

  const USERS_FILE = path.join(dataDir, 'users.json');
  const SESS_FILE = path.join(dataDir, 'sessions.json');
  const PIC_DIR = path.join(dataDir, 'user-avatars');
  try { fs.mkdirSync(PIC_DIR, { recursive: true }); } catch (e) {}

  // ---------------------------------------------------------------- storage
  let users = {};       // id -> record
  let sessions = {};    // sha(token) -> { uid, exp }
  function loadJson(f, fallback) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (e) {
      try { return JSON.parse(fs.readFileSync(f + '.bak', 'utf8')); } catch (e2) { return fallback; }
    }
  }
  users = loadJson(USERS_FILE, { users: {} }).users || {};
  sessions = loadJson(SESS_FILE, { sessions: {} }).sessions || {};

  let saveTimer = null;
  function writeAtomic(file, obj) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); } catch (e) {}
    fs.renameSync(tmp, file);
  }
  function flush() {
    saveTimer = null;
    try { writeAtomic(USERS_FILE, { users }); writeAtomic(SESS_FILE, { sessions }); }
    catch (e) { console.error('[accounts] save failed:', e.message); }
  }
  function save(now) {
    if (now) { if (saveTimer) clearTimeout(saveTimer); return flush(); }
    if (!saveTimer) saveTimer = setTimeout(flush, 400);
  }
  process.on('exit', () => { if (saveTimer) flush(); });

  const byEmail = (email) => Object.values(users).find((u) => u.emailLower === String(email).toLowerCase());
  const byGoogle = (sub) => Object.values(users).find((u) => u.googleSub && u.googleSub === sub);
  const userCount = () => Object.keys(users).length;

  function purge() {
    const now = Date.now();
    let changed = false;
    for (const [id, u] of Object.entries(users)) {
      if (!u.verified && now - u.created > VERIFY_MS) { dropUser(id, true); changed = true; }
    }
    for (const [h, s] of Object.entries(sessions)) if (s.exp < now) { delete sessions[h]; changed = true; }
    if (changed) save();
  }
  function dropUser(id, quiet) {
    const u = users[id];
    if (!u) return;
    if (u.pic) { try { fs.unlinkSync(path.join(PIC_DIR, u.pic + '.webp')); } catch (e) {} }
    for (const [h, s] of Object.entries(sessions)) if (s.uid === id) delete sessions[h];
    delete users[id];
    if (!quiet) save(true);
  }
  setInterval(purge, 3600 * 1000).unref();
  purge();

  // ---------------------------------------------------------------- helpers
  const buckets = new Map();
  function limited(key, max, windowMs) {
    const now = Date.now();
    const b = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (b.length >= max) { buckets.set(key, b); return true; }
    b.push(now); buckets.set(key, b);
    return false;
  }
  setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > 3600e3) buckets.delete(k); }, 600e3).unref();

  async function hashPassword(pw) {
    const salt = crypto.randomBytes(16);
    const h = await scrypt(pw, salt, 64);
    return 's1$' + salt.toString('hex') + '$' + h.toString('hex');
  }
  async function checkPassword(pw, stored) {
    try {
      const [v, s, h] = String(stored).split('$');
      if (v !== 's1') return false;
      const calc = await scrypt(pw, Buffer.from(s, 'hex'), 64);
      const want = Buffer.from(h, 'hex');
      return calc.length === want.length && crypto.timingSafeEqual(calc, want);
    } catch (e) { return false; }
  }

  function parseCookies(req) {
    const out = {};
    String(req.headers.cookie || '').split(';').forEach((p) => {
      const i = p.indexOf('=');
      if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    });
    return out;
  }
  function isSecure(req) { return !!(req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https'); }
  function setCookie(req, res, token, maxAgeMs) {
    res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}; HttpOnly; SameSite=Lax${isSecure(req) ? '; Secure' : ''}`);
  }
  function startSession(req, res, uid) {
    const token = newToken();
    sessions[sha(token)] = { uid, exp: Date.now() + SESSION_MS };
    setCookie(req, res, token, SESSION_MS);
    const u = users[uid];
    if (u) u.lastLogin = Date.now();
    save(true);
  }
  function currentUser(req) {
    const t = parseCookies(req)[COOKIE];
    if (!t) return null;
    const s = sessions[sha(t)];
    if (!s || s.exp < Date.now()) return null;
    const u = users[s.uid];
    if (!u || u.disabled) return null;
    return u;
  }
  // Same check as currentUser(), but from a raw Cookie header (used by the game sockets, e.g. voice chat).
  function userFromCookieHeader(header) {
    const t = parseCookies({ headers: { cookie: header || '' } })[COOKIE];
    if (!t) return null;
    const s = sessions[sha(t)];
    if (!s || s.exp < Date.now()) return null;
    const u = users[s.uid];
    return (u && !u.disabled && u.verified) ? u : null;
  }
  function publicUser(u) {
    return {
      id: u.id, name: u.name, email: u.email, playerName: u.playerName || '', avatar: u.avatar || '',
      hasPhoto: !!u.pic, photo: u.pic || null, hasPassword: !!u.passHash, google: !!u.googleSub, created: u.created,
    };
  }

  // ---------------------------------------------------------------- email (Brevo)
  async function sendMail(to, subject, html, text) {
    const key = env().BREVO_API_KEY, from = env().MAIL_FROM;
    if (!key || !from) {
      log(`[accounts] EMAIL NOT CONFIGURED (set BREVO_API_KEY and MAIL_FROM). Would send to ${to}: ${subject}`);
      return { ok: false, reason: 'not_configured' };
    }
    try {
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: { name: env().MAIL_FROM_NAME || '28 Gulan', email: from }, to: [{ email: to }], subject, htmlContent: html, textContent: text }),
      });
      if (!r.ok) { const body = await r.text().catch(() => ''); console.error('[accounts] Brevo error', r.status, body.slice(0, 300)); return { ok: false, reason: 'provider_' + r.status }; }
      return { ok: true };
    } catch (e) { console.error('[accounts] mail send failed:', e.message); return { ok: false, reason: 'network' }; }
  }
  function mailShell(title, bodyHtml, btnText, link) {
    return `<div style="font-family:Arial,Helvetica,sans-serif;background:#f4efe6;padding:24px"><div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;border-top:5px solid #c9a227">
<h2 style="margin:0 0 12px;color:#241a12">${escHtml(title)}</h2><div style="color:#333;font-size:15px;line-height:1.5">${bodyHtml}</div>
<p style="text-align:center;margin:26px 0"><a href="${escHtml(link)}" style="background:#c9a227;color:#241a12;text-decoration:none;font-weight:bold;padding:13px 26px;border-radius:8px;display:inline-block">${escHtml(btnText)}</a></p>
<p style="color:#777;font-size:12px;word-break:break-all">Button not working? Copy this link into your browser:<br>${escHtml(link)}</p>
<p style="color:#999;font-size:12px">If you didn't ask for this, you can ignore this email.</p></div></div>`;
  }
  async function sendVerify(u) {
    const t = newToken();
    u.verifyHash = sha(t); u.verifyExp = Date.now() + VERIFY_MS;
    save(true);
    const link = `${PUBLIC_URL()}/api/auth/verify?t=${encodeURIComponent(t)}`;
    const r = await sendMail(u.email, 'Confirm your email for 28 Gulan',
      mailShell('Welcome to 28 Gulan, ' + escHtml(u.name), 'Tap the button to confirm your email and finish creating your account. The link works for 3 days.', 'Confirm my email', link),
      `Welcome to 28 Gulan, ${u.name}.\nConfirm your email: ${link}\n(The link works for 3 days. If you didn't sign up, ignore this.)`);
    r.link = link;
    return r;
  }
  async function sendReset(u) {
    const t = newToken();
    u.resetHash = sha(t); u.resetExp = Date.now() + RESET_MS;
    save(true);
    const link = `${PUBLIC_URL()}/?reset=${encodeURIComponent(t)}`;
    const r = await sendMail(u.email, 'Reset your 28 Gulan password',
      mailShell('Reset your password', 'Tap the button to choose a new password. The link works for 1 hour and only once.', 'Choose a new password', link),
      `Reset your 28 Gulan password: ${link}\n(The link works for 1 hour. If you didn't ask, ignore this.)`);
    r.link = link;
    return r;
  }

  // ---------------------------------------------------------------- photo
  async function processPhoto(dataUrl) {
    const m = /^data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
    if (!m) return { error: 'bad_image' };
    const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    if (buf.length < 100 || buf.length > 600 * 1024) return { error: 'too_big' };
    const isWebp = buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!(isWebp || isJpeg || isPng)) return { error: 'bad_image' };
    if (sharp) {
      try {
        const out = await sharp(buf, { limitInputPixels: 5000 * 5000, failOn: 'none' }).rotate()
          .resize(256, 256, { fit: 'cover', position: 'centre' }).webp({ quality: 80 }).toBuffer();
        if (out.length > 120 * 1024) return { error: 'too_big' };
        return { buf: out };
      } catch (e) { return { error: 'bad_image' }; }
    }
    if (isWebp && buf.length <= 120 * 1024) return { buf };       // no server-side converter: trust the browser-made WebP
    return { error: 'no_converter' };
  }

  // ---------------------------------------------------------------- routes
  const router = express.Router();
  const MINE = ['/api/auth', '/api/account', '/api/admin/users'];     // never touch any other route's body limit
  router.use(MINE, express.json({ limit: '800kb' }));
  router.use(MINE, (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  // Cross-site pages cannot add a custom header to a request, so requiring one on every write blocks CSRF.
  router.use(MINE, (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('x-k28') !== '1' && !req.originalUrl.startsWith('/api/admin/')) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    next();
  });
  const fail = (res, status, error, extra) => res.status(status).json(Object.assign({ ok: false, error }, extra || {}));
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { console.error('[accounts]', e); fail(res, 500, 'server_error'); });

  router.get('/api/auth/config', (req, res) => {
    res.json({ ok: true, google: env().GOOGLE_CLIENT_ID || null, mail: !!(env().BREVO_API_KEY && env().MAIL_FROM), open: userCount() < MAX_USERS(), max: MAX_USERS() });
  });

  router.post('/api/auth/signup', wrap(async (req, res) => {
    if (limited('su:' + req.ip, 8, 3600e3)) return fail(res, 429, 'too_many');
    const b = req.body || {};
    const name = cleanText(b.name, 40);
    const email = String(b.email || '').trim().slice(0, 120);
    const pw = String(b.password || '');
    if (name.length < 2) return fail(res, 400, 'bad_name');
    if (!EMAIL_RE.test(email)) return fail(res, 400, 'bad_email');
    if (pw.length < 8 || pw.length > 100) return fail(res, 400, 'bad_password');
    if (b.agree !== true) return fail(res, 400, 'need_agree');
    if (nameBad(name)) return fail(res, 400, 'name_not_allowed');
    let u = byEmail(email);
    if (u && (u.verified || u.googleSub)) return fail(res, 409, 'exists');
    if (!u) {
      if (userCount() >= MAX_USERS()) return fail(res, 403, 'full');
      u = { id: crypto.randomBytes(8).toString('hex'), created: Date.now(), verified: false, avatar: '', playerName: '' };
      users[u.id] = u;
    }
    u.name = name; u.email = email; u.emailLower = email.toLowerCase();
    u.passHash = await hashPassword(pw);
    const r = await sendVerify(u);
    if (!r.ok && r.reason === 'not_configured' && env().ACCOUNTS_DEV_ECHO !== '1') {
      // Without email we cannot confirm anyone -- don't leave a stuck account behind.
      dropUser(u.id);
      return fail(res, 503, 'mail_not_configured');
    }
    const out = { ok: true, sent: r.ok };
    if (env().ACCOUNTS_DEV_ECHO === '1') out.devLink = r.link;      // local testing only
    if (!r.ok && r.reason !== 'not_configured') out.sent = false;
    res.json(out);
  }));

  router.get('/api/auth/verify', (req, res) => {
    const h = sha(req.query.t || '');
    const u = Object.values(users).find((x) => x.verifyHash && x.verifyHash === h);
    if (!u || u.verifyExp < Date.now()) return res.redirect('/?verified=0');
    u.verified = true; u.verifyHash = null; u.verifyExp = 0;
    startSession(req, res, u.id);
    res.redirect('/?verified=1');
  });

  router.post('/api/auth/resend', wrap(async (req, res) => {
    const email = String((req.body || {}).email || '').trim().slice(0, 120);
    if (limited('rs:' + req.ip, 6, 3600e3) || limited('rs:' + email.toLowerCase(), 3, 3600e3)) return fail(res, 429, 'too_many');
    const u = byEmail(email);
    if (u && !u.verified && u.passHash) await sendVerify(u);
    res.json({ ok: true });
  }));

  router.post('/api/auth/login', wrap(async (req, res) => {
    const b = req.body || {};
    const email = String(b.email || '').trim().slice(0, 120);
    if (limited('li:' + req.ip, 20, 15 * 60e3) || limited('li:' + email.toLowerCase(), 10, 15 * 60e3)) return fail(res, 429, 'too_many');
    const u = byEmail(email);
    const ok = u && u.passHash && await checkPassword(String(b.password || ''), u.passHash);
    if (!ok) { if (!u) await scrypt('x', 'dummy-salt-123456', 64); return fail(res, 401, 'bad_login'); }
    if (u.disabled) return fail(res, 403, 'disabled');
    if (!u.verified) return fail(res, 403, 'unverified', { email: u.email });
    startSession(req, res, u.id);
    res.json({ ok: true, user: publicUser(u) });
  }));

  router.post('/api/auth/logout', (req, res) => {
    const t = parseCookies(req)[COOKIE];
    if (t) { delete sessions[sha(t)]; save(true); }
    setCookie(req, res, '', 0);
    res.json({ ok: true });
  });

  router.post('/api/auth/forgot', wrap(async (req, res) => {
    const email = String((req.body || {}).email || '').trim().slice(0, 120);
    if (limited('fg:' + req.ip, 8, 3600e3) || limited('fg:' + email.toLowerCase(), 3, 3600e3)) return fail(res, 429, 'too_many');
    const u = byEmail(email);
    let link;
    if (u && !u.disabled) { const r = await sendReset(u); link = r.link; }
    const out = { ok: true };
    if (env().ACCOUNTS_DEV_ECHO === '1') out.devLink = link;
    res.json(out);
  }));

  router.post('/api/auth/reset', wrap(async (req, res) => {
    if (limited('rp:' + req.ip, 15, 3600e3)) return fail(res, 429, 'too_many');
    const b = req.body || {};
    const pw = String(b.password || '');
    if (pw.length < 8 || pw.length > 100) return fail(res, 400, 'bad_password');
    const h = sha(b.token || '');
    const u = Object.values(users).find((x) => x.resetHash && x.resetHash === h);
    if (!u || u.resetExp < Date.now()) return fail(res, 400, 'bad_token');
    if (u.disabled) return fail(res, 403, 'disabled');
    u.passHash = await hashPassword(pw);
    u.resetHash = null; u.resetExp = 0; u.verified = true;
    for (const [k, s] of Object.entries(sessions)) if (s.uid === u.id) delete sessions[k];   // sign out everywhere else
    startSession(req, res, u.id);
    res.json({ ok: true, user: publicUser(u) });
  }));

  router.post('/api/auth/google', wrap(async (req, res) => {
    const cid = env().GOOGLE_CLIENT_ID;
    if (!cid) return fail(res, 503, 'google_not_configured');
    if (limited('go:' + req.ip, 30, 15 * 60e3)) return fail(res, 429, 'too_many');
    const cred = String((req.body || {}).credential || '');
    if (cred.length < 100 || cred.length > 4000) return fail(res, 400, 'bad_token');
    let info;
    try {
      const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(cred));
      info = await r.json();
      if (!r.ok) return fail(res, 401, 'bad_token');
    } catch (e) { return fail(res, 502, 'google_unreachable'); }
    const okIss = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
    if (info.aud !== cid || !okIss || String(info.email_verified) !== 'true' || !info.sub || !info.email || Number(info.exp) * 1000 < Date.now()) {
      return fail(res, 401, 'bad_token');
    }
    let u = byGoogle(info.sub) || byEmail(info.email);
    let isNew = false;
    if (u) {
      if (u.disabled) return fail(res, 403, 'disabled');
      if (!u.googleSub) u.googleSub = info.sub;
      u.verified = true;
    } else {
      if (userCount() >= MAX_USERS()) return fail(res, 403, 'full');
      isNew = true;
      u = { id: crypto.randomBytes(8).toString('hex'), created: Date.now(), verified: true, googleSub: info.sub, avatar: '', playerName: '',
        email: String(info.email).slice(0, 120), emailLower: String(info.email).toLowerCase(), name: cleanText(info.name || info.given_name || String(info.email).split('@')[0], 40) || 'Player' };
      users[u.id] = u;
    }
    startSession(req, res, u.id);
    res.json({ ok: true, isNew, user: publicUser(u) });
  }));

  router.get('/api/account/me', (req, res) => {
    const u = currentUser(req);
    if (!u) return res.json({ ok: true, user: null });
    const t = parseCookies(req)[COOKIE];
    const s = sessions[sha(t)];
    if (s && s.exp - Date.now() < SESSION_MS - 24 * 3600e3) { s.exp = Date.now() + SESSION_MS; setCookie(req, res, t, SESSION_MS); save(); }   // keep active players signed in
    res.json({ ok: true, user: publicUser(u) });
  });

  // Short-lived pass for the game sockets (voice chat): a socket that connected before the player signed in still
  // carries the old cookie, so the page asks for this token and presents it instead.
  const socketTokens = new Map();      // sha(token) -> { uid, exp }
  setInterval(() => { const n = Date.now(); for (const [k, v] of socketTokens) if (v.exp < n) socketTokens.delete(k); }, 600e3).unref();
  router.get('/api/account/socket-token', (req, res) => {
    const u = currentUser(req);
    if (!u || !u.verified) return fail(res, 401, 'not_signed_in');
    const t = newToken();
    socketTokens.set(sha(t), { uid: u.id, exp: Date.now() + 12 * 3600e3 });
    res.json({ ok: true, token: t });
  });
  function redeemSocketToken(t) {
    if (!t || typeof t !== 'string' || t.length < 20) return null;
    const e = socketTokens.get(sha(t));
    if (!e || e.exp < Date.now()) return null;
    const u = users[e.uid];
    return (u && !u.disabled && u.verified) ? u : null;
  }

  router.put('/api/account/profile', wrap(async (req, res) => {
    const u = currentUser(req);
    if (!u) return fail(res, 401, 'not_signed_in');
    const b = req.body || {};
    if (b.playerName != null) {
      const pn = cleanText(b.playerName, 12);
      if (pn.length < 2) return fail(res, 400, 'bad_player_name');
      if (nameBad(pn)) return fail(res, 400, 'name_not_allowed');
      const clash = Object.values(users).find((x) => x.id !== u.id && x.playerName && x.playerName.toLowerCase() === pn.toLowerCase());
      if (clash) return fail(res, 409, 'name_taken');
      u.playerName = pn;
    }
    if (b.avatar != null) {
      const a = String(b.avatar);
      if ((u.pic && a === u.pic) || avatarOk(a)) u.avatar = a;
      else return fail(res, 400, 'bad_avatar');
    }
    save(true);
    res.json({ ok: true, user: publicUser(u) });
  }));

  router.post('/api/account/photo', wrap(async (req, res) => {
    const u = currentUser(req);
    if (!u) return fail(res, 401, 'not_signed_in');
    if (limited('ph:' + u.id, 10, 3600e3)) return fail(res, 429, 'too_many');
    const r = await processPhoto((req.body || {}).data);
    if (r.error) return fail(res, 400, r.error);
    const key = 'pic_' + crypto.randomBytes(5).toString('hex');
    fs.writeFileSync(path.join(PIC_DIR, key + '.webp'), r.buf);
    if (u.pic) { try { fs.unlinkSync(path.join(PIC_DIR, u.pic + '.webp')); } catch (e) {} }
    u.pic = key; u.avatar = key;
    save(true);
    res.json({ ok: true, user: publicUser(u), bytes: r.buf.length });
  }));

  router.delete('/api/account/photo', (req, res) => {
    const u = currentUser(req);
    if (!u) return fail(res, 401, 'not_signed_in');
    if (u.pic) { try { fs.unlinkSync(path.join(PIC_DIR, u.pic + '.webp')); } catch (e) {} if (u.avatar === u.pic) u.avatar = ''; u.pic = null; }
    save(true);
    res.json({ ok: true, user: publicUser(u) });
  });

  router.post('/api/account/delete', wrap(async (req, res) => {
    const u = currentUser(req);
    if (!u) return fail(res, 401, 'not_signed_in');
    if (String((req.body || {}).confirm || '') !== 'DELETE') return fail(res, 400, 'need_confirm');
    dropUser(u.id);
    setCookie(req, res, '', 0);
    log('[accounts] user deleted their own account');
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- admin
  router.get('/api/admin/users', (req, res) => {
    if (!adminAuth(req, res)) return;
    const now = Date.now();
    const rows = Object.values(users).sort((a, b) => b.created - a.created).map((u) => ({
      id: u.id, name: u.name, email: u.email, playerName: u.playerName || '', avatar: u.avatar || '',
      verified: !!u.verified, google: !!u.googleSub, password: !!u.passHash, disabled: !!u.disabled,
      created: u.created, lastLogin: u.lastLogin || 0,
      sessions: Object.values(sessions).filter((s) => s.uid === u.id && s.exp > now).length,
    }));
    res.json({ ok: true, max: MAX_USERS(), total: rows.length, verified: rows.filter((r) => r.verified).length,
      mail: !!(env().BREVO_API_KEY && env().MAIL_FROM), google: !!env().GOOGLE_CLIENT_ID, users: rows });
  });
  router.post('/api/admin/users/:id/disable', (req, res) => {
    if (!adminAuth(req, res)) return;
    const u = users[req.params.id];
    if (!u) return fail(res, 404, 'not_found');
    u.disabled = !!(req.body || {}).disabled;
    if (u.disabled) for (const [h, s] of Object.entries(sessions)) if (s.uid === u.id) delete sessions[h];
    save(true);
    res.json({ ok: true });
  });
  router.post('/api/admin/users/:id/verify', (req, res) => {
    if (!adminAuth(req, res)) return;
    const u = users[req.params.id];
    if (!u) return fail(res, 404, 'not_found');
    u.verified = true; save(true);
    res.json({ ok: true });
  });
  router.delete('/api/admin/users/:id', (req, res) => {
    if (!adminAuth(req, res)) return;
    if (!users[req.params.id]) return fail(res, 404, 'not_found');
    dropUser(req.params.id);
    res.json({ ok: true });
  });

  // error handler for bad JSON / oversize bodies, scoped to this router
  router.use(MINE, (err, req, res, next) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) return fail(res, 413, 'too_big');
    if (err && err.type === 'entity.parse.failed') return fail(res, 400, 'bad_json');
    next(err);
  });

  return {
    router,
    userFromCookieHeader,
    redeemSocketToken,
    hasPic: (k) => PIC_RE.test(String(k || '')) && Object.values(users).some((u) => u.pic === k),
    picPath: (k) => (PIC_RE.test(String(k || '')) ? path.join(PIC_DIR, k + '.webp') : null),
    PIC_RE,
    _users: () => users,
  };
}

module.exports = { createAccounts };
