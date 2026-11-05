'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const DATA_DIR = process.env.HONGGUO_DATA_DIR || '/media/internal/hongguo-webos';
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const COVER_DIR = path.join(DATA_DIR, 'covers-v2');
const LEGACY_COVER_DIR = path.join(DATA_DIR, 'covers');
const FEED_FILE = path.join(DATA_DIR, 'feeds.json');
const FFMPEG = process.env.HONGGUO_FFMPEG || path.join(__dirname, 'ffmpeg');
const MAX_MEDIA = 3;
const MAX_COVER_JOBS = 3;
const CHANNELS = new Set(['推荐', '真人剧', '漫剧']);
const FEED_FRESH_MS = 15 * 60 * 1000;
const FEED_STALE_MS = 24 * 60 * 60 * 1000;
const FEED_REFRESH_ITEMS = 28;
const FEED_MAX_ITEMS = 84;
const SERIES_TTL_MS = 10 * 60 * 1000;
const PLAY_TTL_MS = 10 * 60 * 1000;
const DOWNLOAD_STALL_MS = 30000;

function validId(value) {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(value || '');
}

function publicSeries(item) {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    cover: item.cover_url,
    episodeCount: item.episode_count,
  };
}

function permittedCover(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && /(^|\.)(fqnovelpic\.com|byteimg\.com|pstatp\.com|snssdk\.com|bytecdn\.cn)$/.test(parsed.hostname);
  } catch {
    return false;
  }
}

// Text shown on the TV; the SDK's own messages are English and name internals.
function describeError(error, pathname) {
  if (error.code === 'ANONYMOUS_LIMITED' && pathname === '/play') return '平台限制了匿名设备的播放次数，这一集现在拿不到播放地址。已经缓存的分集仍可观看。';
  if (error.code === 'RATE_LIMITED') return '请求太频繁，请稍后再试';
  return error.message || String(error);
}

// Runs at most `size` tasks; the newest waiter goes first so covers that just
// scrolled into view are not stuck behind ones the user has moved past.
class Slots {
  constructor(size) {
    this.free = size;
    this.waiting = [];
  }

  async run(task) {
    if (this.free > 0) this.free--;
    else await new Promise((resolve) => this.waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.waiting.pop();
      if (next) next();
      else this.free++;
    }
  }
}

function runFfmpeg(args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-4000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
    });
  });
}

class HongguoServer {
  constructor() {
    this.token = crypto.randomBytes(24).toString('hex');
    this.sdkPromise = null;
    this.feeds = new Map();
    this.feedJobs = new Map();
    this.refreshing = new Set();
    this.series = new Map();
    this.jobs = new Map();
    this.plays = new Map();
    this.progress = new Map();
    this.coverJobs = new Map();
    this.coverSlots = new Slots(MAX_COVER_JOBS);
  }

  sdk() {
    if (!this.sdkPromise) {
      this.sdkPromise = import('openhongguo')
        .then(({ createClient }) => createClient({ profile: path.join(DATA_DIR, 'anonymous.json'), retryAttempts: 2 }))
        .catch((error) => { this.sdkPromise = null; throw error; });
    }
    return this.sdkPromise;
  }

  loadFeeds() {
    if (!this.feedsLoaded) {
      this.feedsLoaded = fsp.readFile(FEED_FILE, 'utf8').then((text) => {
        for (const [channel, entry] of Object.entries(JSON.parse(text))) this.feeds.set(channel, entry);
      }).catch(() => {});
    }
    return this.feedsLoaded;
  }

  saveFeeds() {
    this.feedSave = (this.feedSave || Promise.resolve()).then(async () => {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const partial = `${FEED_FILE}.${process.pid}.partial`;
      await fsp.writeFile(partial, JSON.stringify(Object.fromEntries(this.feeds)));
      await fsp.rename(partial, FEED_FILE);
    }).catch((error) => console.error('[hongguo] save feeds', error));
    return this.feedSave;
  }

  async fetchFeedPage(channel, cursor) {
    const page = await (await this.sdk()).discover({ channel, cursor });
    return {
      items: (page.items || []).filter((item) => item.id).map(publicSeries),
      cursor: page.cursor || '',
      hasMore: Boolean(page.has_more && page.cursor),
    };
  }

  // A discover call takes seconds and pages can only be fetched one after
  // another, so a request never waits for more than one. Any feed from the last
  // day is served at once and refreshed behind the scenes for the next launch.
  async getFeed(channel = '推荐', cursor = '') {
    if (!CHANNELS.has(channel)) throw new Error('无效的频道');
    await this.loadFeeds();
    if (cursor) return this.nextFeedPage(channel, cursor);
    const cached = this.feeds.get(channel);
    const age = cached ? Date.now() - cached.at : Infinity;
    if (age < FEED_STALE_MS) {
      if (age >= FEED_FRESH_MS) this.refreshFeed(channel);
      return cached.page;
    }
    return this.firstFeedPage(channel);
  }

  firstFeedPage(channel) {
    if (this.feedJobs.has(channel)) return this.feedJobs.get(channel);
    const job = this.fetchFeedPage(channel, '').then((page) => {
      if (!page.items.length) throw new Error('暂时没有取到剧集');
      this.feeds.set(channel, { page, at: Date.now() });
      this.saveFeeds();
      return page;
    }).finally(() => this.feedJobs.delete(channel));
    this.feedJobs.set(channel, job);
    return job;
  }

  // Keeps what the user has scrolled through, so the next launch opens as full.
  async nextFeedPage(channel, cursor) {
    const page = await this.fetchFeedPage(channel, cursor);
    const cached = this.feeds.get(channel);
    if (cached && cached.page.cursor === cursor && cached.page.items.length < FEED_MAX_ITEMS) {
      const seen = new Set(cached.page.items.map((item) => item.id));
      cached.page = {
        items: [...cached.page.items, ...page.items.filter((item) => !seen.has(item.id))],
        cursor: page.cursor,
        hasMore: page.hasMore,
      };
      this.saveFeeds();
    }
    return page;
  }

  async refreshFeed(channel) {
    if (this.refreshing.has(channel)) return;
    this.refreshing.add(channel);
    try {
      const fresh = { items: [], cursor: '', hasMore: true };
      const seen = new Set();
      while (fresh.hasMore && fresh.items.length < FEED_REFRESH_ITEMS) {
        const page = await this.fetchFeedPage(channel, fresh.cursor);
        for (const item of page.items) {
          if (!seen.has(item.id)) {
            seen.add(item.id);
            fresh.items.push(item);
          }
        }
        fresh.cursor = page.cursor;
        fresh.hasMore = page.hasMore;
      }
      if (fresh.items.length) {
        this.feeds.set(channel, { page: fresh, at: Date.now() });
        await this.saveFeeds();
      }
    } catch (error) {
      console.error('[hongguo] refresh feed', channel, error);
    } finally {
      this.refreshing.delete(channel);
    }
  }

  async getSeries(id) {
    if (!validId(id)) throw new Error('无效的剧集 ID');
    const cached = this.series.get(id);
    if (cached && Date.now() - cached.at < SERIES_TTL_MS) return cached.value;
    const sdk = await this.sdk();
    const [series, page] = await Promise.all([
      sdk.getSeries(id).catch(() => ({ id })),
      sdk.listEpisodes(id),
    ]);
    const value = {
      series: publicSeries(series),
      episodes: (page.items || []).filter((item) => validId(item.id)).map((item) => ({
        id: item.id,
        number: item.number,
        title: item.title,
        playable: item.playable !== false,
      })),
    };
    if (this.series.size >= 50) this.series.clear();
    this.series.set(id, { value, at: Date.now() });
    return value;
  }

  mediaFile(id) {
    return path.join(MEDIA_DIR, `${id}.mp4`);
  }

  async resolveWithDeviceReset(sdk, id) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let result;
      try {
        result = await sdk.resolvePlayback(id);
      } catch (error) {
        if (error?.code !== 'ANONYMOUS_LIMITED' || attempt === 2) throw error;
        await sdk.resetDevice();
        continue;
      }
      if (result?.playback?.streams?.length) return result;
      if (attempt < 2) await sdk.resetDevice();
    }
    throw Object.assign(new Error('没有可播放的地址'), { code: 'ANONYMOUS_LIMITED' });
  }

  async resolve(id) {
    if (!validId(id)) throw new Error('无效的分集 ID');
    const mediaPath = `/media?id=${encodeURIComponent(id)}`;
    // A play model is scarce for an anonymous device: never spend one on an
    // episode that is on disk, being prepared, or was just resolved.
    if (fs.existsSync(this.mediaFile(id)) || this.jobs.has(id)) return { episodeId: id, mediaPath };
    const known = this.plays.get(id);
    if (known && Date.now() - known.at < PLAY_TTL_MS) {
      this.prepareMedia(id).catch((error) => console.error('[hongguo] media preparation', error));
      return { episodeId: id, mediaPath };
    }
    const sdk = await this.sdk();
    const result = await this.resolveWithDeviceReset(sdk, id);
    const file = (result.playback?.streams || []).find((item) => item.url && !item.hls && !item.dash);
    if (!file) throw new Error('当前分集没有可用的 MP4 地址');
    if (result.playback.protected && !result.contentKey?.key) throw new Error('无法取得内容密钥');
    this.plays.set(id, {
      urls: [file.url, file.backup_url].filter(Boolean),
      key: result.contentKey?.key,
      codec: file.codec,
      at: Date.now(),
    });
    this.prepareMedia(id).catch((error) => console.error('[hongguo] media preparation', error));
    return { episodeId: id, duration: result.playback.duration_seconds, mediaPath };
  }

  mediaStatus(id) {
    if (!validId(id)) throw new Error('无效的分集 ID');
    if (fs.existsSync(this.mediaFile(id))) return { stage: 'ready' };
    return this.progress.get(id) || { stage: 'idle' };
  }

  async pruneMedia() {
    const names = (await fsp.readdir(MEDIA_DIR)).filter((name) => name.endsWith('.mp4'));
    const rows = await Promise.all(names.map(async (name) => ({ name, time: (await fsp.stat(path.join(MEDIA_DIR, name))).mtimeMs })));
    rows.sort((a, b) => b.time - a.time);
    await Promise.all(rows.slice(MAX_MEDIA).map((row) => fsp.unlink(path.join(MEDIA_DIR, row.name))));
  }

  // The whole file has to land before ffmpeg can rewrite it, which takes a while
  // on a TV. The page follows `progress` and only then points the video at it:
  // a media element left waiting on a silent request gives up by itself.
  async download(id, play, target, signal, arm) {
    let failure;
    for (const url of play.urls) {
      try {
        const response = await fetch(url, { signal });
        if (!response.ok || !response.body) throw new Error(`视频下载失败 (${response.status})`);
        const progress = { stage: 'downloading', received: 0, total: Number(response.headers.get('content-length')) || 0 };
        this.progress.set(id, progress);
        await pipeline(Readable.fromWeb(response.body), async function* (source) {
          for await (const chunk of source) {
            arm();
            progress.received += chunk.length;
            yield chunk;
          }
        }, fs.createWriteStream(target));
        return;
      } catch (error) {
        failure = error;
      }
    }
    throw failure || new Error('当前分集没有可用的 MP4 地址');
  }

  prepareMedia(id) {
    if (this.jobs.has(id)) return this.jobs.get(id);
    const job = (async () => {
      await fsp.mkdir(MEDIA_DIR, { recursive: true });
      const output = this.mediaFile(id);
      if (fs.existsSync(output)) return output;
      const play = this.plays.get(id);
      if (!play) throw new Error('播放地址已失效，请重新打开该集');
      this.progress.set(id, { stage: 'downloading', received: 0, total: 0 });
      const encrypted = path.join(MEDIA_DIR, `${id}.${process.pid}.download`);
      const partial = path.join(MEDIA_DIR, `${id}.${process.pid}.partial.mp4`);
      const controller = new AbortController();
      let stall;
      const arm = () => {
        clearTimeout(stall);
        stall = setTimeout(() => controller.abort(new Error('视频下载超时')), DOWNLOAD_STALL_MS);
      };
      try {
        arm();
        await this.download(id, play, encrypted, controller.signal, arm);
        clearTimeout(stall);
        this.progress.set(id, { stage: 'processing' });
        const args = [];
        if (play.key) args.push('-decryption_key', play.key);
        args.push('-i', encrypted, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy');
        // hvc1 is what the TV expects for HEVC, and ffmpeg refuses it on H.264.
        if (!/264|avc/i.test(play.codec || '')) args.push('-tag:v', 'hvc1');
        args.push('-movflags', '+faststart', '-y', partial);
        await runFfmpeg(args);
        await fsp.rename(partial, output);
        await this.pruneMedia();
        this.progress.delete(id);
        return output;
      } catch (error) {
        this.progress.set(id, { stage: 'failed', error: error.message || String(error) });
        throw error;
      } finally {
        clearTimeout(stall);
        await Promise.all([fsp.unlink(encrypted).catch(() => {}), fsp.unlink(partial).catch(() => {})]);
      }
    })().finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
    return job;
  }

  cover(source) {
    if (!permittedCover(source)) throw new Error('无效的封面地址');
    // The URL's signature and host change with every response; the path is the image.
    const name = crypto.createHash('sha256').update(new URL(source).pathname).digest('hex');
    if (this.coverJobs.has(name)) return this.coverJobs.get(name);
    const output = path.join(COVER_DIR, `${name}.jpg`);
    if (fs.existsSync(output)) return output;
    const job = this.coverSlots.run(async () => {
      await fsp.mkdir(COVER_DIR, { recursive: true });
      const input = path.join(COVER_DIR, `${name}.input`);
      const partial = path.join(COVER_DIR, `${name}.partial.jpg`);
      try {
        const response = await fetch(source, { signal: AbortSignal.timeout(20000) });
        if (!response.ok || !response.body) throw new Error(`封面下载失败 (${response.status})`);
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(input));
        await runFfmpeg(['-i', input, '-frames:v', '1', '-vf', 'scale=320:-1', '-q:v', '4', '-y', partial], 30000);
        await fsp.rename(partial, output);
        return output;
      } finally {
        await Promise.all([fsp.unlink(input).catch(() => {}), fsp.unlink(partial).catch(() => {})]);
      }
    }).finally(() => this.coverJobs.delete(name));
    this.coverJobs.set(name, job);
    return job;
  }

  json(res, status, value) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify(value));
  }

  async file(req, res, filename, type) {
    const stats = await fsp.stat(filename);
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let start = 0;
    let end = stats.size - 1;
    if (match) {
      if (match[1]) start = Number(match[1]);
      else start = Math.max(0, stats.size - Number(match[2]));
      if (match[2] && match[1]) end = Math.min(end, Number(match[2]));
      if (start > end || start >= stats.size) {
        res.writeHead(416, { 'content-range': `bytes */${stats.size}`, 'access-control-allow-origin': '*' });
        return res.end();
      }
    }
    res.writeHead(match ? 206 : 200, {
      'content-type': type,
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
      ...(match ? { 'content-range': `bytes ${start}-${end}/${stats.size}` } : {}),
      'access-control-allow-origin': '*',
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filename, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  async handle(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, HEAD, OPTIONS' });
      return res.end();
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.searchParams.get('token') !== this.token) return this.json(res, 403, { error: 'forbidden' });
    try {
      if (url.pathname === '/health') return this.json(res, 200, { ok: true });
      if (url.pathname === '/feed') return this.json(res, 200, await this.getFeed(url.searchParams.get('channel') || '推荐', url.searchParams.get('cursor') || ''));
      if (url.pathname === '/search') {
        const term = (url.searchParams.get('q') || '').trim().slice(0, 80);
        if (!term) throw new Error('请输入搜索词');
        const sdk = await this.sdk();
        const page = await sdk.search(term, { cursor: url.searchParams.get('cursor') || '', pageSize: 24 });
        const found = (page.items || []).filter((item) => item.id);
        // Search results carry no cover; the batch lookup fills them in.
        const details = await sdk.getSeriesBatch(found.map((item) => item.id)).catch(() => []);
        const byId = new Map(details.map((detail) => [(detail.series || detail).id, detail.series || detail]));
        return this.json(res, 200, {
          items: found.map((item) => publicSeries({ ...byId.get(item.id), ...item, cover_url: item.cover_url || byId.get(item.id)?.cover_url })),
          cursor: page.cursor || '',
          hasMore: Boolean(page.has_more && page.cursor),
        });
      }
      if (url.pathname === '/series') return this.json(res, 200, await this.getSeries(url.searchParams.get('id')));
      if (url.pathname === '/play') return this.json(res, 200, await this.resolve(url.searchParams.get('id')));
      if (url.pathname === '/progress') return this.json(res, 200, this.mediaStatus(url.searchParams.get('id')));
      if (url.pathname === '/media') {
        const id = url.searchParams.get('id');
        if (!validId(id)) throw new Error('无效的分集 ID');
        const filename = fs.existsSync(this.mediaFile(id)) ? this.mediaFile(id) : await this.prepareMedia(id);
        return this.file(req, res, filename, 'video/mp4');
      }
      if (url.pathname === '/cover') return this.file(req, res, await this.cover(url.searchParams.get('url')), 'image/jpeg');
      return this.json(res, 404, { error: 'not found' });
    } catch (error) {
      console.error('[hongguo] request', url.pathname, error);
      if (!res.headersSent) this.json(res, 502, { error: describeError(error, url.pathname), code: error.code });
      else res.destroy();
    }
  }

  listen() {
    fsp.rm(LEGACY_COVER_DIR, { recursive: true, force: true }).catch(() => {});
    this.server = http.createServer((req, res) => this.handle(req, res));
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve(this.server.address().port));
    });
  }

  close() {
    if (this.server) this.server.close();
  }
}

module.exports = { HongguoServer, permittedCover, validId };
