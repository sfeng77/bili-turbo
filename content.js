// Bili Turbo —— 改善 B 站在海外/跨境线路下的卡顿
// 1. 分块并发：把播放器的一个大 Range 请求拆成多个块并发下载
// 2. 对冲请求：某块迟迟不回来时，再发一个相同请求，谁先到用谁
// 3. 预读缓存：在播放器要数据之前，提前把后面若干 MB 下载到内存里，
//    相当于把播放器只有几十秒的缓冲区"加长"
(() => {
  if (window.__biliTurbo) return;

  const CFG = {
    block: 512 * 1024,            // 块大小
    conc: 4,                      // 同时下载的块数（实测 4 路最稳，16 路反而更慢）
    hedgeMs: 2500,                // 一个块超过这么久还没回来，就补发一个对冲请求
    blockTimeout: 15000,          // 单次请求超时
    retries: 3,                   // 单块失败后的重试轮数
    aheadBytes: 12 * 1024 * 1024, // 每个文件往后预读的字节数
    cacheMax: 160 * 1024 * 1024,  // 内存缓存上限
    // CDN 切换：B 站给海外用户分配的 cosov / akamai / aliov 镜像经常很慢，
    // 同一个签名 URL 换成下面这些镜像也能用。按顺序优先，失败多的自动降级。
    switchCdn: true,
    hosts: [
      'upos-sz-mirrorhw.bilivideo.com',
      'upos-sz-mirror08c.bilivideo.com',
      'upos-sz-mirrorali.bilivideo.com',
      'upos-sz-mirrorcos.bilivideo.com'
    ],
    debug: false
  };
  const stats = { served: 0, servedBytes: 0, cacheHits: 0, fetched: 0, fetchedBytes: 0, hedges: 0, retries: 0, passthrough: 0 };
  const log = (...a) => CFG.debug && console.log('[Bili Turbo]', ...a);

  const P = XMLHttpRequest.prototype;
  const oOpen = P.open, oSend = P.send, oSetHeader = P.setRequestHeader,
        oAbort = P.abort, oGetHeader = P.getResponseHeader;

  // ---------------- 块缓存 ----------------
  const cache = new Map();   // key -> ArrayBuffer（Map 插入顺序当 LRU）
  let cacheBytes = 0;
  function cacheGet(key) {
    const b = cache.get(key);
    if (b) { cache.delete(key); cache.set(key, b); }
    return b;
  }
  function cachePut(key, buf) {
    if (cache.has(key)) return;
    cache.set(key, buf); cacheBytes += buf.byteLength;
    for (const [k, b] of cache) {
      if (cacheBytes <= CFG.cacheMax) break;
      cache.delete(k); cacheBytes -= b.byteLength;
    }
  }

  // ---------------- CDN 选择 ----------------
  const hostFails = CFG.hosts.map(() => 0);
  const hostOk = CFG.hosts.map(() => 0);
  // 按"失败次数少、排得靠前"排序，返回主机下标
  const rankedHosts = () => CFG.hosts.map((_, i) => i)
    .sort((a, b) => (hostFails[a] - hostOk[a] * 0.2) - (hostFails[b] - hostOk[b] * 0.2) || a - b);
  setInterval(() => { for (let i = 0; i < hostFails.length; i++) { hostFails[i] *= 0.5; hostOk[i] *= 0.5; } }, 60000);

  // akamai 的 URL 签名格式不同，换主机前先从 __playinfo__ 里找同一文件的 bilivideo 地址
  function signedBiliUrl(u) {
    if (/\.bilivideo\.com$/.test(u.host)) return u;
    try {
      const d = window.__playinfo__ && window.__playinfo__.data && window.__playinfo__.data.dash;
      const all = d ? [...(d.video || []), ...(d.audio || []), ...((d.dolby && d.dolby.audio) || []), ...((d.flac && d.flac.audio) ? [d.flac.audio] : [])] : [];
      for (const it of all) for (const s of [it.baseUrl || it.base_url, ...(it.backupUrl || it.backup_url || [])]) {
        if (!s) continue;
        const c = new URL(s);
        if (c.pathname === u.pathname && /\.bilivideo\.com$/.test(c.host)) return c;
      }
    } catch (_) {}
    return null;
  }
  // 返回 { url, hostIdx }；hostIdx = -1 表示用原地址
  function pickUrl(orig, rank) {
    if (!CFG.switchCdn) return { url: orig, hostIdx: -1 };
    const u = new URL(orig);
    if (!/^upos-/.test(u.host)) return { url: orig, hostIdx: -1 };   // PCDN 等其他格式不动
    const b = signedBiliUrl(u);
    if (!b) return { url: orig, hostIdx: -1 };
    const order = rankedHosts();
    const idx = order[rank % order.length];
    b.host = CFG.hosts[idx];
    return { url: b.href, hostIdx: idx };
  }

  // ---------------- 底层请求 ----------------
  function rawGet(url, s, e) {
    const x = new XMLHttpRequest();
    x.__inner = true;
    const p = new Promise((resolve, reject) => {
      oOpen.call(x, 'GET', url);
      x.responseType = 'arraybuffer';
      oSetHeader.call(x, 'Range', `bytes=${s}-${e}`);
      x.timeout = CFG.blockTimeout;
      x.onload = () => {
        if ((x.status === 206 || x.status === 200) && x.response) {
          resolve({ buf: x.response, cr: oGetHeader.call(x, 'Content-Range') });
        } else {
          reject(Object.assign(new Error('status ' + x.status), { fatal: x.status === 416 }));
        }
      };
      x.onerror = x.ontimeout = () => reject(new Error('net'));
      x.onabort = () => reject(new Error('abort'));
      oSend.call(x);
    });
    p.xhr = x;
    return p;
  }

  // 对冲请求：先发一个；hedgeMs 内没回来（或先失败了）就再发一个，谁先成功用谁。
  // 对冲请求发到另一个 CDN，一个镜像卡住时另一个能顶上
  function hedgedGet(url, s, e, attempt) {
    return new Promise((resolve, reject) => {
      const xs = [];
      let launched = 0, fails = 0, settled = false, timer, firstHost = -1;
      const finish = () => { settled = true; clearTimeout(timer); xs.forEach(x => { if (x.readyState !== 4) try { oAbort.call(x); } catch (_) {} }); };
      const launch = () => {
        const { url: u, hostIdx } = pickUrl(url, launched + attempt * 2);
        if (launched === 0) firstHost = hostIdx;
        launched++;
        const p = rawGet(u, s, e);
        xs.push(p.xhr);
        p.then(r => {
          if (hostIdx >= 0) hostOk[hostIdx]++;
          if (!settled) { finish(); resolve(r); }
        }, err => {
          if (err.message === 'abort') return;
          if (hostIdx >= 0) hostFails[hostIdx] += /status 40/.test(err.message) ? 5 : 1;
          if (settled) return;
          fails++;
          if (err.fatal) { finish(); reject(err); }
          else if (launched < 2) { clearTimeout(timer); launch(); }
          else if (fails >= launched) { finish(); reject(err); }
        });
      };
      timer = setTimeout(() => { if (!settled && launched < 2) { stats.hedges++; if (firstHost >= 0) hostFails[firstHost] += 0.5; log('hedge', s); launch(); } }, CFG.hedgeMs);
      launch();
    });
  }

  // ---------------- 调度器 ----------------
  const tasks = new Map();     // key -> task
  const queue = [];
  let running = 0, seq = 0;
  const fileSize = new Map();  // path -> 文件总大小
  const lastEnd = new Map();   // path -> 播放器上次请求的结束位置

  async function runTask(t) {
    const s = t.idx * CFG.block;
    let e = s + CFG.block - 1;
    const size = fileSize.get(t.path);
    if (size) e = Math.min(e, size - 1);
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await hedgedGet(t.url, s, e, attempt);
        if (r.cr) { const tot = +r.cr.split('/')[1]; if (tot) fileSize.set(t.path, tot); }
        stats.fetched++; stats.fetchedBytes += r.buf.byteLength;
        return r.buf;
      } catch (err) {
        if (err.fatal || attempt >= CFG.retries) throw err;
        stats.retries++; log('retry', t.key, err.message);
      }
    }
  }

  function pump() {
    while (running < CFG.conc && queue.length) {
      queue.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
      const t = queue.shift();
      running++;
      runTask(t).then(buf => { cachePut(t.key, buf); t.resolve(buf); }, err => t.reject(err))
        .finally(() => { running--; tasks.delete(t.key); pump(); });
    }
  }

  function getBlock(url, path, idx, prio) {
    const key = path + '#' + idx;
    const hit = cacheGet(key);
    if (hit) return { promise: Promise.resolve(hit), hit: true };
    let t = tasks.get(key);
    if (t) { if (prio < t.prio) t.prio = prio; return { promise: t.promise, hit: false }; }
    t = { key, url, path, idx, prio, seq: seq++ };
    t.promise = new Promise((res, rej) => { t.resolve = res; t.reject = rej; });
    t.promise.catch(() => {});
    tasks.set(key, t); queue.push(t); pump();
    return { promise: t.promise, hit: false };
  }

  function prefetch(url, path, fromByte) {
    const size = fileSize.get(path);
    if (size && fromByte >= size) return;
    const lastByte = size ? Math.min(size - 1, fromByte + CFG.aheadBytes) : fromByte + CFG.aheadBytes;
    for (let i = Math.floor(fromByte / CFG.block); i <= Math.floor(lastByte / CFG.block); i++) getBlock(url, path, i, 1);
  }

  function dropQueuedPrefetch(path) {
    for (let i = queue.length - 1; i >= 0; i--) {
      const t = queue[i];
      if (t.path === path && t.prio > 0) { queue.splice(i, 1); tasks.delete(t.key); t.reject(new Error('dropped')); }
    }
  }

  // ---------------- XHR 拦截 ----------------
  P.open = function (method, url) {
    try { this.__bt = { url: new URL(String(url), location.href).href, method: String(method).toUpperCase(), headers: {} }; } catch (_) {}
    return oOpen.apply(this, arguments);
  };
  P.setRequestHeader = function (k, v) {
    if (this.__bt) this.__bt.headers[String(k).toLowerCase()] = v;
    return oSetHeader.apply(this, arguments);
  };

  function fire(xhr, type, loaded, total) {
    const ev = (type === 'progress' || type === 'load' || type === 'loadend')
      ? new ProgressEvent(type, { lengthComputable: true, loaded, total }) : new Event(type);
    xhr.dispatchEvent(ev);
  }
  function setState(xhr, st) {
    Object.defineProperty(xhr, 'readyState', { value: st, configurable: true });
    fire(xhr, 'readystatechange');
  }

  P.send = function () {
    const bt = this.__bt;
    const m = bt && !this.__inner && bt.method === 'GET' && /\.m4s(\?|$)/.test(bt.url) &&
      /^bytes=(\d+)-(\d+)$/.exec(bt.headers.range || '');
    if (!m || this.responseType !== 'arraybuffer') {
      if (bt && !this.__inner && /\.m4s$/.test(new URL(bt.url).pathname)) stats.passthrough++;
      return oSend.apply(this, arguments);
    }
    const xhr = this, start = +m[1], end = +m[2], total = end - start + 1;
    const path = new URL(bt.url).pathname;

    // 跳转进度（非连续请求）时，丢掉旧位置还在排队的预读
    const le = lastEnd.get(path);
    if (le != null && Math.abs(start - (le + 1)) > CFG.block * 2) dropQueuedPrefetch(path);
    lastEnd.set(path, end);

    let done = false, loaded = 0, allHit = true;
    bt.cancel = () => { if (done) return false; done = true; return true; };
    const jobs = [];
    for (let i = Math.floor(start / CFG.block); i <= Math.floor(end / CFG.block); i++) {
      const j = getBlock(bt.url, path, i, 0);
      if (!j.hit) allHit = false;
      jobs.push(j.promise.then(buf => {
        const bs = i * CFG.block;
        const from = Math.max(start, bs) - bs;
        const n = Math.max(0, Math.min(end + 1, bs + buf.byteLength) - bs - from);
        loaded += n;
        if (!done) fire(xhr, 'progress', loaded, total);
        return { off: bs + from - start, bytes: new Uint8Array(buf, from, n) };
      }));
    }
    prefetch(bt.url, path, end + 1);   // 顺手预读后面的数据

    setTimeout(() => { if (!done) setState(xhr, 1); }, 0);
    Promise.all(jobs).then(pieces => {
      if (done) return; done = true;
      let len = 0; for (const p of pieces) len = Math.max(len, p.off + p.bytes.byteLength);
      const out = new Uint8Array(len);
      for (const p of pieces) out.set(p.bytes, p.off);
      const hdrs = { 'content-type': 'video/mp4', 'content-length': String(len),
                     'content-range': `bytes ${start}-${start + len - 1}/${fileSize.get(path) || '*'}` };
      xhr.getResponseHeader = k => hdrs[String(k).toLowerCase()] ?? null;
      xhr.getAllResponseHeaders = () => Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
      for (const [k, v] of [['status', 206], ['statusText', 'Partial Content'], ['response', out.buffer],
                            ['responseURL', bt.url]]) Object.defineProperty(xhr, k, { value: v, configurable: true });
      stats.served++; stats.servedBytes += len; if (allHit) stats.cacheHits++;
      setState(xhr, 2); setState(xhr, 3); setState(xhr, 4);
      fire(xhr, 'load', len, len); fire(xhr, 'loadend', len, len);
    }).catch(err => {
      if (done) return; done = true;
      log('fail', err && err.message);
      Object.defineProperty(xhr, 'status', { value: 0, configurable: true });
      setState(xhr, 4); fire(xhr, 'error'); fire(xhr, 'loadend', 0, total);
    });
  };

  P.abort = function () {
    if (this.__bt && this.__bt.cancel) {
      if (!this.__bt.cancel()) return;   // 已完成的请求不再触发 abort
      setState(this, 4); fire(this, 'abort'); fire(this, 'loadend', 0, 0);
      return;   // 底层块继续下载，结果留在缓存里，之后还能用
    }
    return oAbort.apply(this, arguments);
  };

  window.__biliTurbo = {
    CFG, stats,
    status() {
      const v = document.querySelector('video');
      let ahead = 0;
      if (v) for (let i = 0; i < v.buffered.length; i++)
        if (v.buffered.start(i) <= v.currentTime + 0.5 && v.buffered.end(i) > v.currentTime) ahead = v.buffered.end(i) - v.currentTime;
      return { ...stats, hosts: rankedHosts().map(i => CFG.hosts[i].split('.')[0].replace('upos-sz-', '') + ':' + hostFails[i].toFixed(1)), cacheMB: +(cacheBytes / 1048576).toFixed(1), queued: queue.length, running, playerBufferSec: +ahead.toFixed(1) };
    }
  };
  console.log('[Bili Turbo] 已启用', CFG);
})();
