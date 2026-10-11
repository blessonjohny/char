// Rule-based chat for admin-run ghost players: short, human-sounding, each ghost with its own voice.
// reply(msg, ctx) -> null | string | { text, ask?, next? }
//   ctx = { ghostName, persona, lastAsk, bank:[common short phrases real players use] }
const CITIES = ['London', 'Dubai', 'Kochi', 'Toronto', 'Doha', 'Bangalore', 'Kottayam', 'Singapore', 'Sharjah', 'Trivandrum', 'Melbourne', 'Houston', 'Thrissur', 'Abu Dhabi', 'Calicut', 'Manchester', 'Muscat', 'Chennai', 'New Jersey', 'Kuwait', 'Ernakulam', 'Bahrain', 'Dallas', 'Sydney'];
const EMOJIS = ['🙂', '😄', '😊', '👍', '😂', '🙏', '😅', '🤝', '👌', '😁'];
const FILLERS = ['bro', 'machane', 'da', 'ayyo', 'man', 'boss', 'chetta', 'ha'];
const LAUGHS = ['haha', 'hehe', 'lol', '😂', 'lmao', 'hahaha', 'heh'];
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
function hash(str) { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0; return h; }
function personaFor(name) {
  const h = hash(String(name || 'x'));
  return {
    city: CITIES[h % CITIES.length],
    caps: ['lower', 'sentence', 'plain', 'plain'][(h >> 3) % 4],       // lowercase typer / Capitalised / as-is
    emoji: [0, 0, 1, 1, 2][(h >> 5) % 5],                               // none / rare / often
    emojis: [EMOJIS[(h >> 7) % EMOJIS.length], EMOJIS[(h >> 11) % EMOJIS.length]],
    slang: ((h >> 9) % 3) === 0,                                        // sprinkles "machane/bro/da"
    fillers: [FILLERS[(h >> 13) % FILLERS.length], FILLERS[(h >> 17) % FILLERS.length]],
    laugh: LAUGHS[(h >> 15) % LAUGHS.length],
    dots: ((h >> 19) % 4) === 0,                                        // trails off with ".."
    terse: ((h >> 21) % 3) === 0                                        // prefers the shortest variant
  };
}

// Lines recently used by ANY ghost: never repeat the same words across ghosts / tables.
const recent = [];
function fresh(options) {
  const ok = options.filter(o => !recent.includes(o));
  const c = pick(ok.length ? ok : options);
  recent.push(c); if (recent.length > 60) recent.shift();
  return c;
}
function style(text, p) {
  let t = text;
  if (p.caps === 'lower') t = t.replace(/^[A-Z]/, c => c.toLowerCase());
  else if (p.caps === 'sentence') t = t.charAt(0).toUpperCase() + t.slice(1);
  if (p.slang && Math.random() < 0.3 && t.length < 24) t = Math.random() < 0.5 ? pick(p.fillers) + ' ' + t : t + ' ' + pick(p.fillers);
  if (p.dots && Math.random() < 0.3) t = t.replace(/[.!]+$/, '') + '..';
  if (p.emoji && !/[\u{1F300}-\u{1FAFF}]/u.test(t) && Math.random() < (p.emoji === 2 ? 0.6 : 0.22)) t += ' ' + pick(p.emojis);
  return t;
}
const say = (opts, p) => style(fresh(p.terse ? opts.slice().sort((a, b) => a.length - b.length).slice(0, Math.max(2, Math.ceil(opts.length / 2))) : opts), p);

const KERALA = /(kerala|kochi|cochin|ernakulam|thrissur|trissur|kottayam|calicut|kozhikode|tvm|trivandrum|thiruvananthapuram|palakkad|kannur|alappuzha|alleppey|kollam|malappuram|pathanamthitta|idukki|wayanad)/i;
const has = (t, re) => re.test(t);

function reply(msgRaw, ctx) {
  const raw = String(msgRaw || '').trim();
  if (!raw || raw.length > 70) return null;                    // long / complicated: a quiet player just doesn't answer
  const low = raw.toLowerCase();
  if (/\b(age|old are|gender|male|female|boy|girl|single|married|number|phone|whatsapp|insta|facebook|snap|email|address|salary)\b/.test(low)) return null;
  if (/\b(bot|robot|ai|fake|real person|real player|ghost|computer|human)\b/.test(low)) return null;   // never claim anything about being real: just stay quiet
  const t = low.replace(/[^\p{L}\p{N}\s?']/gu, ' ').replace(/\s+/g, ' ').trim();
  const p = ctx.persona || personaFor(ctx.ghostName);
  const L = p.laugh;

  const askedLoc = has(t, /\b(where|wher|whr)\b.*\b(from|live|stay|based|are you|r u)\b|\bwhere r u\b|\bur from\b|\bu from\b|\bfrom where\b|\bwhich (country|city|place)\b|എവിടെ/);
  const greet = has(t, /^(hi+|hii+|hey+|heyy+|hello+|helo|hai|hlo|yo|namaste|namaskaram|good (morning|evening|afternoon|night)|gm|sup|wassup|whats up|what's up)\b|^ഹായ്|^നമസ്കാരം/);
  const howAre = has(t, /\bhow (are|r) (you|u)\b|\bhow r u\b|\bhow are u\b|\bhow's it going\b|സുഖമാണോ|എന്തുണ്ട്/);
  const goodGame = has(t, /\b(well played|nice (play|one|bid|hand|game|call|move)|good (play|one|bid|hand|game|call|move)|gg|wp|great|smart|clever|well done|super|kidu|polichu|poli|superb)\b/);
  const unlucky = has(t, /\b(unlucky|bad luck|so close|damn|oh no|ayyo|missed|close one|tough|pain|ouch)\b/);
  const again = has(t, /\b(again|one more|rematch|another one|another game|next game)\b/);
  const kunukku = has(t, /\b(kunukku|kunikku|cot|maru)\b/);
  const sorry = has(t, /\b(sorry|oops|my bad|mistake)\b/);
  const bye = has(t, /\b(bye|good night|gn|see you|see ya|cya|brb|gtg|got to go|have to go)\b/);
  const thanks = has(t, /\b(thanks|thank you|thx|ty|nanni)\b/);
  const laughing = has(t, /\b(lol|lmao|haha+|hehe+|rofl)\b|😂|🤣|😆|😄/);
  const youQ = has(t, /^(and you|and u|u\?|you\?|wbu|hbu|what about you|what about u)\b/);
  const keralaQ = has(t, /\b(malayali|malayalee|kerala|mallu)\b.*\?|\bmalayali\b/) && !askedLoc;

  // They're answering "where are you from?" with a place
  if (ctx.lastAsk === 'where' && raw.length <= 40 && !raw.includes('?') && !greet) {
    const place = raw.replace(/^(i'?m|im|i am|from|iam|me|in|am from|i live in|living in)\s+/i, '').replace(/[.!]+$/, '').trim();
    if (!place || place.length > 28) return null;
    const pl = place.charAt(0).toUpperCase() + place.slice(1);
    if (KERALA.test(place)) return { text: say([`${pl}! nammude naadu`, `oh ${pl}, i'm kerala too`, `ahh ${pl} 😄 same side`, `${pl} nice, which part?`], p), next: Math.random() < 0.4 ? say(['onam ku poyirunno?', 'hope it\'s not raining there', 'good place to be'], p) : null };
    return { text: say([`oh ${pl}, nice`, `${pl}! never been there`, `${pl} nice, how's it there?`, `oh cool, ${pl}`, `nice, i have a friend in ${pl}`], p) };
  }
  if (askedLoc) return { text: say([`${p.city}, u?`, `${p.city}. you?`, `${p.city} 🙂 u?`, `from ${p.city}, and you?`, `${p.city} now. you?`], p), ask: 'where' };
  if (keralaQ) return say(['yes kerala', 'yep, originally kerala', 'kerala roots, ' + p.city + ' now', 'aanu 🙂'], p);
  if (howAre) return say(['good', 'fine, you?', 'all good', 'doing good', 'good good, u?', 'not bad'], p);
  if (greet) {
    const hi = say(['hi', 'hello', 'hey', 'hey there', 'hello there', 'hii', 'namaste', 'hai'], p);
    return Math.random() < 0.3 ? { text: hi, next: say(['where u from?', 'where are you from?', 'which country?'], p), ask: 'where' } : hi;
  }
  if (goodGame) return say(['thanks!', 'thank you', 'luck mostly', `${L} thanks`, 'you too', 'cards were good', 'nice game', 'same to you'], p);
  if (unlucky) return say(['happens', `${L} that was close`, 'next one', 'tough one', 'cards didn\'t help', 'ayyo', 'it\'s ok, next hand'], p);
  if (again) return say(['sure', 'ok one more', 'why not', 'yes lets go', 'okay'], p);
  if (kunukku) return say([`${L} kunukku`, 'next hand then', 'ayyo kunukku', 'that kunukku..', 'we go again'], p);
  if (youQ) return say([p.city, 'good', 'same here', 'fine'], p);
  if (thanks) return say(['np', 'welcome', '👍', 'anytime', 'sure'], p);
  if (sorry) return say(['no problem', 'all good', 'happens', 'it\'s ok'], p);
  if (bye) return say(['bye', 'see you', 'take care', 'bye bye', 'ok bye', 'cya'], p);
  if (laughing) return Math.random() < 0.6 ? say([L, 'haha', 'lol', '😂', 'true'], p) : null;
  // Nothing matched: mostly silence; sometimes echo a very common short phrase real players use
  if (raw.length <= 22 && !raw.includes('?') && ctx.bank && ctx.bank.length && Math.random() < 0.3) return style(fresh(ctx.bank), p);
  return null;
}
module.exports = { reply, personaFor };
