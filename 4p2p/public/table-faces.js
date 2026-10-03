// ============================================================================
// table-faces.js  --  no two players at the same table ever show the same face.
//
// Each bot NAME has a preferred face (the roster), but there are only 18 male
// faces for 66 male names, and Hold'em hashes names onto faces, so two players
// at one table could end up looking identical. TableFaces.update() looks at the
// players currently seated and, wherever two of them would show the same face,
// gives the later bot another unused face of the SAME gender (female names keep
// female faces, male keep male). Humans' own chosen avatars are never changed
// and are reserved first, so a bot can never look like a real player either.
// Deterministic (same seats -> same faces), so it never flickers between renders.
// ============================================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TableFaces = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MALE = [1, 5, 8, 19, 24, 26, 27, 34, 39, 43, 45, 48, 58, 62, 63, 66, 74, 80];
  const FEMALE = [2, 3, 4, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 22, 23, 25, 28, 29, 30, 31, 32, 33, 35, 36, 37, 38, 40, 41, 42, 44, 46, 47, 49, 50, 51, 52, 53, 54, 55, 56, 57, 59, 60, 61, 64, 65, 67, 68, 69, 70, 71, 72, 73, 75, 76, 77, 78, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90];
  const MALE_SET = new Set(MALE.map((n) => 'toon' + n));
  const FEMALE_SET = new Set(FEMALE.map((n) => 'toon' + n));
  const MALE_KEYS = MALE.map((n) => 'toon' + n);
  const FEMALE_KEYS = FEMALE.map((n) => 'toon' + n);
  const ALL_KEYS = MALE_KEYS.concat(FEMALE_KEYS);
  let current = {};            // name -> resolved face key for the table as last seen

  function keyOf(x) {          // accepts 'toon12' or markup containing toon12.png
    const m = typeof x === 'string' && x.match(/toon(\d+)/);
    return m ? 'toon' + m[1] : null;
  }
  function hash(s) { let h = 0; s = String(s || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }

  // seats: [{ name, avatar (a human's explicit pick, or falsy), pref (a bot's preferred face key/markup) }]
  // opts.anyGender: choose replacements from every face (used where names have no gender, e.g. Hold'em)
  function update(seats, opts) {
    const anyGender = !!(opts && opts.anyGender);
    const used = new Set();
    const out = {};
    // 1) humans first: their pick is final and reserved
    (seats || []).forEach((s) => {
      if (!s) return;
      const k = keyOf(s.avatar);
      if (k) { out[s.name] = k; used.add(k); }
    });
    // 2) everyone else, in seat order
    (seats || []).forEach((s) => {
      if (!s || out[s.name]) return;
      let k = keyOf(s.pref);
      if (!k) k = ALL_KEYS[hash(s.name) % ALL_KEYS.length];
      if (used.has(k)) {
        const pool = anyGender ? ALL_KEYS : (MALE_SET.has(k) ? MALE_KEYS : (FEMALE_SET.has(k) ? FEMALE_KEYS : ALL_KEYS));
        const start = hash(s.name) % pool.length;
        for (let i = 0; i < pool.length; i++) {
          const cand = pool[(start + i) % pool.length];
          if (!used.has(cand)) { k = cand; break; }
        }
      }
      out[s.name] = k; used.add(k);
    });
    current = out;
    return out;
  }
  // The face for one seat. Falls back to the preferred face when update() hasn't seen this name.
  function faceFor(name, pref) { return current[name] || keyOf(pref) || ALL_KEYS[hash(name) % ALL_KEYS.length]; }
  function reset() { current = {}; }
  return { update, faceFor, reset, keyOf, MALE_KEYS, FEMALE_KEYS };
}));
