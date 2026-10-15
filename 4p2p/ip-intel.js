// Detailed IP lookup for the admin visitor log (city, region, zip, ISP, organisation, ASN, reverse-DNS, mobile/VPN/datacenter flags).
// The offline geoip-lite database often knows only the country, so each new IP is looked up online (ip-api.com, falling back to ipwho.is),
// cached on disk, and rate-limited so the free tiers are never hit hard. Admin-only data; nothing here is sent to players.
const fs = require('fs');
const FIELDS = 'status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,asname,reverse,mobile,proxy,hosting,query';
const TTL = 30 * 24 * 3600 * 1000;
const BOT_HOSTS = [[/googlebot\.com$|google\.com$|googleusercontent\.com$/i, 'Googlebot (Google crawler)'], [/search\.msn\.com$/i, 'Bingbot (Microsoft crawler)'], [/crawl\.yahoo\.net$/i, 'Yahoo crawler'], [/yandex\.(com|ru|net)$/i, 'Yandex crawler'], [/baidu\.(com|jp)$/i, 'Baidu crawler'], [/applebot|apple\.com$/i, 'Applebot'], [/facebook\.com$|fbsv\.net$/i, 'Facebook crawler'], [/amazonaws\.com$/i, 'Amazon cloud server']];
function botOf(hostname, isp, org) {
  const h = hostname || '';
  for (const [re, name] of BOT_HOSTS) if (h && re.test(h)) return name;
  return null;
}
function create({ file, fetchImpl, intervalMs }) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  const queue = [], queued = new Set(); let running = false, saveT = null;
  const gap = intervalMs == null ? 1600 : intervalMs;
  function save() { if (saveT) return; saveT = setTimeout(() => { saveT = null; try { fs.writeFileSync(file, JSON.stringify(cache)); } catch (e) {} }, 3000); }
  function isPrivate(ip) { return !ip || /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd|fe80)/i.test(ip); }
  async function fetchJson(url) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 7000);
    try { const r = await f(url, { signal: ctl.signal }); if (!r.ok) throw new Error('http ' + r.status); return await r.json(); } finally { clearTimeout(t); }
  }
  async function remote(ip) {
    try {
      const j = await fetchJson('http://ip-api.com/json/' + encodeURIComponent(ip) + '?fields=' + FIELDS);
      if (j && j.status === 'success') return { city: j.city || null, regionName: j.regionName || null, region: j.region || null, country: j.countryCode || null, countryName: j.country || null, zip: j.zip || null, lat: j.lat, lon: j.lon, timezone: j.timezone || null, isp: j.isp || null, org: j.org || null, asn: j.as || null, hostname: j.reverse || null, mobile: !!j.mobile, proxy: !!j.proxy, hosting: !!j.hosting };
    } catch (e) {}
    try {
      const j = await fetchJson('https://ipwho.is/' + encodeURIComponent(ip));
      if (j && j.success !== false) return { city: j.city || null, regionName: j.region || null, region: j.region_code || null, country: j.country_code || null, countryName: j.country || null, zip: j.postal || null, lat: j.latitude, lon: j.longitude, timezone: j.timezone && j.timezone.id || null, isp: j.connection && j.connection.isp || null, org: j.connection && j.connection.org || null, asn: j.connection && j.connection.asn ? 'AS' + j.connection.asn : null, hostname: null, mobile: false, proxy: false, hosting: false };
    } catch (e) {}
    return null;
  }
  async function pump() {
    if (running) return; running = true;
    while (queue.length) {
      const job = queue.shift(); queued.delete(job.ip);
      let info = await remote(job.ip);
      if (info) { info.bot = botOf(info.hostname, info.isp, info.org); info.at = Date.now(); cache[job.ip] = info; save(); }
      job.cbs.forEach(cb => { try { cb(info); } catch (e) {} });
      if (queue.length) await new Promise(r => setTimeout(r, gap));
    }
    running = false;
  }
  // lookup(ip, cb): cb(info|null) — immediately when cached, otherwise after the (rate-limited) online lookup
  function lookup(ip, cb) {
    if (!f || isPrivate(ip)) { cb(null); return; }
    const c = cache[ip]; if (c && Date.now() - c.at < TTL) { cb(c); return; }
    const ex = queue.find(q => q.ip === ip); if (ex) { ex.cbs.push(cb); return; }
    queue.push({ ip, cbs: [cb] }); queued.add(ip); pump();
  }
  return { lookup, cache: () => cache, pending: () => queue.length };
}
function applyTo(entry, info) {
  if (!info || !entry) return false;
  ['city', 'regionName', 'region', 'country', 'countryName', 'zip', 'timezone', 'isp', 'org', 'asn', 'hostname', 'mobile', 'proxy', 'hosting', 'bot'].forEach(k => { if (info[k] != null && info[k] !== '') entry[k] = info[k]; });
  if (info.lat != null && info.lon != null) { entry.lat = info.lat; entry.lon = info.lon; }
  entry.intel = 1; return true;
}
module.exports = { create, applyTo };
