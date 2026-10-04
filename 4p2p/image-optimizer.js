'use strict';
// ============================================================================
// image-optimizer.js  --  serve smaller WebP pictures to browsers that can show them,
// with an off switch (redo) and a "show me the original" override (compare).
//
// The site's avatars and backgrounds ship as PNG/JPG (11 MB of avatars, 5 MB of backgrounds)
// and every player downloads them again and again. For each picture under /images there is
// now a .webp twin next to it. Pages are NOT changed: they keep asking for the .png / .jpg, and
// this middleware answers with the twin when
//     * optimisation is switched on in the admin panel,
//     * the browser says it understands WebP (Accept: image/webp), and
//     * a twin exists.
// Everything else -- an old browser, the switch off, ?nowebp=1 -- gets the original file exactly
// as before. So turning it off (or deleting the .webp files) restores the old behaviour instantly.
// ============================================================================
const fs = require('fs');
const path = require('path');

function createImageOptimizer(opts) {
  const publicDir = opts.publicDir;
  const file = opts.file;                         // settings file on the data volume
  const imagesDir = path.join(publicDir, 'images');
  let settings = { enabled: true };
  const twins = new Set();                        // '/images/x/y.webp' that exist on disk

  function loadSettings() {
    try { if (file && fs.existsSync(file)) { const p = JSON.parse(fs.readFileSync(file, 'utf8')); if (typeof p.enabled === 'boolean') settings.enabled = p.enabled; } }
    catch (e) { console.error('[images] could not read the setting, keeping WebP on:', e.message); }
  }
  function saveSettings() { try { if (file) fs.writeFileSync(file, JSON.stringify(settings)); } catch (e) { console.error('[images] could not save the setting:', e.message); } }
  function scan(dir) {
    let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) scan(p);
      else if (/\.webp$/i.test(ent.name)) twins.add('/' + path.relative(publicDir, p).split(path.sep).join('/'));
    }
  }

  function middleware(req, res, next) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const urlPath = (req.url || '').split('?')[0];
      const m = /^(\/images\/.+)\.(png|jpe?g)$/i.exec(urlPath);
      if (!m) return next();
      res.setHeader('Vary', 'Accept');             // a cache must keep the WebP and the original answers apart
      if (!settings.enabled) return next();
      if (/[?&]nowebp=1(&|$)/.test(req.url || '')) return next();
      if (!/image\/webp/i.test(req.headers.accept || '')) return next();
      const twin = m[1] + '.webp';
      if (!twins.has(twin)) return next();
      const full = path.join(publicDir, twin);
      if (!full.startsWith(imagesDir + path.sep)) return next();         // never leave the images folder
      fs.stat(full, (err, st) => {
        if (err || !st.isFile()) return next();
        const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Cache-Control', 'no-cache');                      // always ask, but the answer is a tiny 304 when unchanged
        res.setHeader('ETag', etag);
        res.setHeader('Last-Modified', st.mtime.toUTCString());
        if (req.headers['if-none-match'] === etag) { res.statusCode = 304; return res.end(); }
        res.setHeader('Content-Length', st.size);
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(full).on('error', () => { try { res.destroy(); } catch (_) {} }).pipe(res);
      });
    } catch (e) { next(); }
  }

  function manifest() {
    try { return JSON.parse(fs.readFileSync(path.join(publicDir, 'image-opt-manifest.json'), 'utf8')); } catch (e) { return null; }
  }
  function status() {
    const m = manifest();
    const groups = {};
    if (m && Array.isArray(m.files)) {
      for (const f of m.files) {
        const g = groups[f.group] || (groups[f.group] = { files: 0, orig: 0, webp: 0, worstSsim: 1 });
        g.files += 1; g.orig += f.orig; g.webp += f.webp; g.worstSsim = Math.min(g.worstSsim, f.ssim);
      }
    }
    return { enabled: settings.enabled, twins: twins.size, groups, files: m ? m.files : [], generated: m ? m.generated : null, avatarQuality: m ? m.avatarQuality : null, backgroundQuality: m ? m.backgroundQuality : null };
  }
  function setEnabled(on) { settings.enabled = !!on; saveSettings(); return settings.enabled; }

  loadSettings(); scan(imagesDir);
  return { middleware, status, setEnabled, _twins: twins };
}

module.exports = { createImageOptimizer };
