// ============================================================================
// name-filter.js  --  blocks profane / abusive PLAYER NAMES on every game.
//
// One file, used in two places so the rules can never drift apart:
//   * every game page loads it (<script src="name-filter.js">) to stop a bad
//     name BEFORE it is sent, with a friendly message;
//   * server.js require()s the very same file and re-checks every name that
//     arrives over a socket -- the server check is the real enforcement (a
//     modified page can skip the browser check, never this one).
//
// HOW IT AVOIDS BLOCKING REAL NAMES ("Scunthorpe problem")
//   Many real names contain short bad words inside them (Kshitij, Nishit,
//   Rishit, Cassandra, Dickson, Assam, Kunnamkulam...). So the list has two
//   tiers:
//     STEMS  - long, unmistakable words (fuck, bitch, cunt...). Blocked even
//              when buried inside a longer word ("xXfuckerXx").
//     WORDS  - short or ambiguous ones (ass, dick, shit, cock, kunna...).
//              Blocked only when they stand alone as a word, an underscore/
//              dot/digit/space-separated part, or a CamelCase part:
//              "Big_Dick", "BigDick", "dick69"  -> blocked
//              "Dickson", "Cassandra", "Kshitij" -> fine.
//   Common tricks are normalised first: capitals, accents, look-alike
//   letters (Cyrillic а/е/о...), leetspeak (f*ck, b1tch, $hit, sh!t, a55),
//   stretched letters (fuuuuck), and spaced-out letters (f u c k / f.u.c.k).
//
// TO ADD OR REMOVE WORDS: edit the two lists below (lowercase, plain
// letters). Words can also be added without touching code by setting the
// server environment variable BANNED_NAME_WORDS="word1,word2" (treated as
// WORDS tier; prefix a word with "~" to make it a STEMS-tier word).
// ============================================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NameFilter = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- STEMS: blocked anywhere inside a name -------------------------------
  const STEMS = [
    // English profanity
    'fuck', 'fck', 'fvck', 'phuck', 'motherfuck', 'bitch', 'biatch', 'bytch',
    'cunt', 'whore', 'slut', 'bastard', 'asshole', 'arsehole', 'dickhead', 'cocksuck',
    'pussy', 'wanker', 'bollock', 'blowjob', 'handjob', 'jackoff', 'jerkoff',
    'dumbass', 'jackass', 'bullshit', 'shithead', 'shitface', 'dipshit', 'shitbag',
    'dildo', 'pornhub', 'jizz', 'rimjob', 'cumshot',
    // slurs
    'nigger', 'nigga', 'faggot', 'fagot', 'retard', 'tranny',
    // Manglish (Malayalam written in English letters) -- unambiguous ones only
    'pundachi', 'pundamone', 'pundamon', 'thayoli', 'thayolli', 'koothichi', 'poorimone',
  ];

  // ---- WORDS: blocked only as a whole word / separated part ----------------
  // (short or ambiguous: they appear inside real names, e.g. "fuk" in
  // Fukushima, "porn" in Pornima, "spic" in Spicer, "shit" in Kshitij)
  const WORDS = [
    'ass', 'arse', 'dick', 'cock', 'shit', 'shite', 'shitty', 'piss', 'pissed',
    'tit', 'tits', 'titty', 'boob', 'boobs', 'cum', 'anal', 'anus', 'penis', 'vagina',
    'fag', 'fags', 'twat', 'prick', 'slag', 'fuk', 'fuc', 'phuk', 'porn', 'sex',
    'rape', 'rapist', 'nazi', 'hitler', 'wtf', 'stfu', 'milf', 'horny', 'skank',
    'douche', 'douchebag', 'cocksucker', 'chink', 'spic', 'kike', 'coon',
    // Manglish
    'kunna', 'thendi', 'koothi', 'oombi',
  ];

  // ---- normalisation -------------------------------------------------------
  // look-alike letters from other alphabets that people use to dodge filters
  const HOMOGLYPH = {
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ј': 'j', 'ѕ': 's',
    'ԁ': 'd', 'ɡ': 'g', 'һ': 'h', 'к': 'k', 'м': 'm', 'н': 'h', 'т': 't', 'в': 'b',
    'α': 'a', 'ο': 'o', 'ρ': 'p', 'ν': 'v', 'ι': 'i', 'κ': 'k', 'τ': 't', 'υ': 'u', 'ε': 'e',
    'ƒ': 'f', 'ß': 'ss', 'ø': 'o', 'æ': 'ae', 'đ': 'd', 'ł': 'l',
  };
  // leetspeak. '1' is ambiguous (i or l), so it is tried both ways.
  const LEET = { '0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i', '+': 't', '|': 'i', '¡': 'i', '€': 'e', '£': 'e' };

  function baseClean(s) {
    s = String(s == null ? '' : s);
    try { s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* very old engines */ }
    // zero-width / invisible characters used to split a word invisibly
    s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g, '');
    // CamelCase boundary -> space BEFORE lowercasing ("BigDick" -> "Big Dick")
    s = s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2');
    s = s.toLowerCase();
    let out = '';
    for (const ch of s) out += (HOMOGLYPH[ch] !== undefined ? HOMOGLYPH[ch] : ch);
    return out;
  }
  // digits are reattached to letters for leet ("b1tch") -- the camel/digit
  // split above is only for the whole-word tier, so leet runs on a separate path
  function leetClean(s, oneAs) {
    s = String(s == null ? '' : s);
    try { s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
    s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g, '');
    s = s.replace(/([a-z])([A-Z])/g, '$1 $2');
    s = s.toLowerCase();
    let out = '';
    for (const ch of s) {
      if (HOMOGLYPH[ch] !== undefined) out += HOMOGLYPH[ch];
      else if (ch === '1') out += oneAs;
      else if (LEET[ch] !== undefined) out += LEET[ch];
      else out += ch;
    }
    return out;
  }

  const collapse = (s) => s.replace(/([a-z])\1+/g, '$1');            // fuuuck -> fuck
  const letterRuns = (s) => s.split(/[^a-z*]+/).filter(Boolean);     // '*' kept: f**k

  // joins runs of single letters: ["f","u","c","k"] -> "fuck"
  function joinSpaced(tokens) {
    const out = [];
    let run = '';
    const flush = () => { if (run) { if (run.length >= 3) out.push(run); run = ''; } };
    for (const t of tokens) {
      if (t.length === 1 && t !== '*') run += t;
      else { flush(); out.push(t); }
    }
    flush();
    // single letters on their own can't be a banned word; run (>=3) pushed above
    return out;
  }
  function joinSpacedKeepSingles(tokens) {
    // like joinSpaced but keeps short runs/singles as separate tokens too
    const out = [];
    let run = '';
    const flush = () => { if (run) { out.push(run); run = ''; } };
    for (const t of tokens) {
      if (t.length === 1 && t !== '*') run += t;
      else { flush(); out.push(t); }
    }
    flush();
    return out;
  }

  // ---- list compilation (collapsed stems, stretch-tolerant word regexes) ----
  let stemSet = [];
  let wordRegexes = [];
  let wordSet = new Set();
  function compile(extraStems, extraWords) {
    stemSet = Array.from(new Set(STEMS.concat(extraStems || []).map((w) => collapse(w.toLowerCase())))).filter((w) => w.length >= 3);
    const words = Array.from(new Set(WORDS.concat(extraWords || []).map((w) => w.toLowerCase()))).filter(Boolean);
    wordSet = new Set(words);
    // each letter may be stretched: "ass" -> ^a+s{2,}$ is wrong for 'ass' (needs
    // both s) so build per-letter-run: runs of the SAME letter in the word
    // need at least that many; a lone letter can repeat freely.
    wordRegexes = words.map((w) => {
      const parts = w.match(/(.)\1*/g) || [];
      const src = parts.map((run) => run[0] + '{' + run.length + ',}').join('');
      return new RegExp('^' + src + '$');
    });
  }

  function wordHit(token) {
    if (!token) return false;
    for (const re of wordRegexes) if (re.test(token)) return true;
    return false;
  }
  // wildcard form: f**k, b*tch, sh*t, a** -- non-* letters must match exactly
  function wildcardHit(token) {
    if (token.indexOf('*') < 0) return false;
    const letters = token.replace(/\*/g, '');
    if (letters.length < 1 || token.length < 3) return false;
    const re = new RegExp('^' + token.replace(/\*/g, '[a-z]') + '$');
    for (const w of wordSet) { if (w.length === token.length && re.test(w)) return true; }
    for (const s of STEMS) { if (s.length === token.length && s.length >= 4 && re.test(s)) return true; }
    return false;
  }
  function stemHit(token) {
    const c = collapse(token);
    for (const s of stemSet) if (c.indexOf(s) >= 0) return true;
    return false;
  }

  const ALLOW = new Set(['scunthorpe']);
  function tokensHit(tokens) {
    for (const t of tokens) {
      if (ALLOW.has(t)) continue;
      if (wordHit(t) || wildcardHit(t)) return true;
      if (t.length >= 3 && stemHit(t)) return true;
    }
    return false;
  }

  // ---- public API ----------------------------------------------------------
  function isBad(name) {
    if (name == null) return false;
    const raw = String(name);
    if (!raw.trim()) return false;
    // pass 1: plain letters, digits/CamelCase act as word breaks
    const t1 = baseClean(raw);
    const runs1 = letterRuns(t1);
    if (tokensHit(runs1) || tokensHit(joinSpaced(joinSpacedKeepSingles(runs1)))) return true;
    // pass 2: leetspeak (1 tried as 'i' and as 'l')
    for (const oneAs of ['i', 'l']) {
      const t2 = leetClean(raw, oneAs);
      const runs2 = letterRuns(t2);
      if (tokensHit(runs2) || tokensHit(joinSpaced(joinSpacedKeepSingles(runs2)))) return true;
    }
    return false;
  }

  const DEFAULT_MESSAGE = "That name isn't allowed. Please choose a different name.";

  // Returns { ok:true } or { ok:false, message }
  function check(name) {
    return isBad(name) ? { ok: false, message: DEFAULT_MESSAGE } : { ok: true };
  }

  // Browser helper: true when fine; otherwise shows the message (using the
  // page's own toast if you pass one, else alert) and returns false.
  function guard(name, show) {
    if (!isBad(name)) return true;
    try {
      if (typeof show === 'function') show(DEFAULT_MESSAGE);
      else if (typeof window !== 'undefined' && typeof window.alert === 'function') window.alert(DEFAULT_MESSAGE);
    } catch (e) { /* never let a UI error let a bad name through */ }
    return false;
  }

  // Server-side extras from the environment (never throws)
  (function loadEnv() {
    let extraStems = [], extraWords = [];
    try {
      const env = (typeof process !== 'undefined' && process.env && process.env.BANNED_NAME_WORDS) || '';
      env.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean).forEach((w) => {
        if (w[0] === '~') extraStems.push(w.slice(1).replace(/[^a-z]/g, ''));
        else extraWords.push(w.replace(/[^a-z]/g, ''));
      });
    } catch (e) {}
    compile(extraStems.filter(Boolean), extraWords.filter(Boolean));
  }());

  return { isBad, check, guard, MESSAGE: DEFAULT_MESSAGE, _lists: { STEMS, WORDS } };
}));
