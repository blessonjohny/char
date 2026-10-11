// Rule-based chat replies for admin-run ghost players, so they answer like a real person at the table.
// reply(msg, ctx) -> string | null. ctx = { ghostName, persona:{city,...}, lastAsk, userName }
const CITIES = ['London', 'Dubai', 'Kochi', 'Toronto', 'Doha', 'Bangalore', 'Kottayam', 'Singapore', 'Sharjah', 'Trivandrum', 'Melbourne', 'Houston', 'Thrissur', 'Abu Dhabi', 'Calicut', 'Manchester', 'Muscat', 'Chennai', 'New Jersey', 'Kuwait'];
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
function hash(str) { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0; return h; }
function personaFor(name) { const h = hash(String(name || 'x')); return { city: CITIES[h % CITIES.length], age: 24 + (h % 17) }; }

const has = (t, re) => re.test(t);
function reply(msgRaw, ctx) {
  const raw = String(msgRaw || '').trim();
  if (!raw) return null;
  const t = raw.toLowerCase().replace(/[^\p{L}\p{N}\s?']/gu, ' ').replace(/\s+/g, ' ').trim();
  if (raw.length > 60) return null;   // long / complicated messages: a quiet player just doesn't answer
  if (/\b(age|old are|gender|male|female|boy|girl|single|married|number|phone|whatsapp|insta|facebook|snap)\b/.test(raw.toLowerCase())) return null;
  const p = ctx.persona || personaFor(ctx.ghostName);
  const askedLoc = has(t, /\b(where|wher|whr)\b.*\b(from|u from|you from|are you|r u|live|stay|based)\b|\bwhere r u\b|\bur from\b|\bu from\b|\bfrom where\b|\bwhich (country|city|place)\b|എവിടെ/);
  const greet = has(t, /^(hi+|hii+|hey+|heyy+|hello+|helo|hai|hlo|yo|namaste|namaskaram|good (morning|evening|afternoon|night)|gm|sup|wassup|whats up|what's up)\b|^ഹായ്|^നമസ്കാരം/);
  const howAre = has(t, /\bhow (are|r) (you|u)\b|\bhow r u\b|\bhow are u\b|\bhow's it going\b|\bwhat's up\b|\bwhats up\b|സുഖമാണോ|എന്തുണ്ട്/);
  const name = has(t, /\b(your|ur|ya) name\b|\bwho are (you|u)\b|\bwho r u\b/);
  const age = has(t, /\bhow old\b|\bur age\b|\byour age\b|\bage\b.*\?/);
  const doWhat = has(t, /\bwhat (do|are) (you|u) (do|doing)\b|\bwhat do u do\b|\bwork\b.*\?|\bjob\b/);
  const compliment = has(t, /\b(well played|nice (play|one|bid|hand|game)|good (play|one|bid|hand|game)|gg|wp|great|smart|clever|well done|super|kidu|polichu|poli)\b/);
  const sorry = has(t, /\b(sorry|oops|my bad|mistake)\b/);
  const bye = has(t, /\b(bye|good night|gn|see you|see ya|cya|brb|gtg|got to go|have to go)\b/);
  const thanks = has(t, /\b(thanks|thank you|thx|ty|nanni)\b/);
  const laugh = has(t, /\b(lol|lmao|haha+|hehe+|rofl)\b|😂|🤣|😆|😄/);
  const playQ = has(t, /\b(play|game)\b.*\b(often|daily|regularly|long|first time|new)\b|\bfirst time\b/);
  const youQ = has(t, /^(and you|and u|u\?|you\?|wbu|hbu|what about you|what about u)\b/);

  // The ghost asked "where are you from?" and the person is answering with a place (short, no question mark)
  if (ctx.lastAsk === 'where' && raw.length <= 40 && !raw.includes('?') && !greet) {
    const place = raw.replace(/^(i'?m|im|i am|from|iam|me|in)\s+/i, '').replace(/[.!]+$/, '');
    return pick([`oh nice, ${place}! never been there`, `${place} nice 😊`, `oh ${place}, i have a friend there`, `nice, how's the weather in ${place}?`]);
  }

  if (askedLoc) return { text: pick([`${p.city}, u?`, `${p.city}. you?`, `${p.city} 🙂 u?`]), ask: 'where' };
  if (howAre) return pick(['good', 'fine 🙂', 'all good', 'good, u?']);
  if (greet) {
    const hi = pick(['hi', 'hello', 'hey', 'hi 🙂', 'hey there', 'hello 🙂']);
    return Math.random() < 0.35 ? { text: `${hi}, where u from?`, ask: 'where' } : hi;
  }
  if (youQ) return pick([`${p.city} 🙂`, 'doing good', 'same here']);
  if (compliment) return pick(['thanks! 😊', 'thank you 🙂', 'haha thanks', 'luck mostly 😄', 'you too!']);
  if (thanks) return pick(['np 🙂', 'welcome!', '👍']);
  if (sorry) return pick(['no problem 🙂', 'all good', 'happens 😄']);
  if (bye) return pick(['bye 👋', 'see you!', 'take care 🙂', 'bye bye']);
  if (laugh) return Math.random() < 0.5 ? pick(['😂', 'haha', '😄']) : null;
  return null;
}
module.exports = { reply, personaFor };
