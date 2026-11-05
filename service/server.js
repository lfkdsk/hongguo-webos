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
const COVER_DIR = path.join(DATA_DIR, 'covers');
const FFMPEG = process.env.HONGGUO_FFMPEG || path.join(__dirname, 'ffmpeg');
const MAX_MEDIA = 3;

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
    this.feed = null;
    this.feedAt = 0;
    this.jobs = new Map();
    this.plays = new Map();
  }

  sdk() {
    if (!this.sdkPromise) {
      this.sdkPromise = import('openhongguo')
        .then(({ createClient }) => createClient({ profile: path.join(DATA_DIR, 'anonymous.json'), retryAttempts: 2 }))
        .catch((error) => { this.sdkPromise = null; throw error; });
    }
    return this.sdkPromise;
  }

  async getFeed() {
    if (this.feed && Date.now() - this.feedAt < 15 * 60 * 1000) return this.feed;
    const sdk = await this.sdk();
    const page = await sdk.discover({});
    const items = (page.items || []).filter((item) => item.id).map(publicSeries);
    if (!items.length) throw new Error('暂时没有取到剧集');
    this.feed = items;
    this.feedAt = Date.now();
    return items;
  }

  async getSeries(id) {
    if (!validId(id)) throw new Error('无效的剧集 ID');
    const sdk = await this.sdk();
    const [series, page] = await Promise.all([
      sdk.getSeries(id).catch(() => ({ id })),
      sdk.listEpisodes(id),
    ]);
    return {
      series: publicSeries(series),
      episodes: (page.items || []).filter((item) => validId(item.id)).map((item) => ({
        id: item.id,
        number: item.number,
        title: item.title,
        playable: item.playable !== false,
      })),
    };
  }

  async resolve(id) {
    if (!validId(id)) throw new Error('无效的分集 ID');
    const sdk = await this.sdk();
    let result = await sdk.resolvePlayback(id);
    if (!result.playback?.streams?.length) {
      await sdk.resetDevice();
      result = await sdk.resolvePlayback(id);
    }
    const file = (result.playback?.streams || []).find((item) => item.url && !item.hls && !item.dash);
    if (!file) throw new Error('当前分集没有可用的 MP4 地址');
    if (result.playback.protected && !result.contentKey?.key) throw new Error('无法取得内容密钥');
    this.plays.set(id, { url: file.url, key: result.contentKey?.key });
    this.prepareMedia(id).catch((error) => console.error('[hongguo] media preparation', error));
    return { episodeId: id, duration: result.playback.duration_seconds, mediaPath: `/media?id=${encodeURIComponent(id)}` };
  }

  async pruneMedia() {
    const names = (await fsp.readdir(MEDIA_DIR)).filter((name) => name.endsWith('.mp4'));
    const rows = await Promise.all(names.map(async (name) => ({ name, time: (await fsp.stat(path.join(MEDIA_DIR, name))).mtimeMs })));
    rows.sort((a, b) => b.time - a.time);
    await Promise.all(rows.slice(MAX_MEDIA).map((row) => fsp.unlink(path.join(MEDIA_DIR, row.name))));
  }

  prepareMedia(id) {
    if (this.jobs.has(id)) return this.jobs.get(id);
    const job = (async () => {
      await fsp.mkdir(MEDIA_DIR, { recursive: true });
      const output = path.join(MEDIA_DIR, `${id}.mp4`);
      if (fs.existsSync(output)) return output;
      const play = this.plays.get(id);
      if (!play) throw new Error('播放地址已失效，请重新打开该集');
      const encrypted = path.join(MEDIA_DIR, `${id}.${process.pid}.download`);
      const partial = path.join(MEDIA_DIR, `${id}.${process.pid}.partial.mp4`);
      try {
        const response = await fetch(play.url, { signal: AbortSignal.timeout(60000) });
        if (!response.ok || !response.body) throw new Error(`视频下载失败 (${response.status})`);
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(encrypted));
        const args = [];
        if (play.key) args.push('-decryption_key', play.key);
        args.push('-i', encrypted, '-map', '0', '-c', 'copy', '-tag:v', 'hvc1', '-movflags', '+faststart', '-y', partial);
        await runFfmpeg(args);
        await fsp.rename(partial, output);
        await this.pruneMedia();
        return output;
      } finally {
        await Promise.all([fsp.unlink(encrypted).catch(() => {}), fsp.unlink(partial).catch(() => {})]);
      }
    })().finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
    return job;
  }

  async cover(source) {
    if (!permittedCover(source)) throw new Error('无效的封面地址');
    await fsp.mkdir(COVER_DIR, { recursive: true });
    const name = crypto.createHash('sha256').update(source).digest('hex');
    const output = path.join(COVER_DIR, `${name}.jpg`);
    if (fs.existsSync(output)) return output;
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
      if (url.pathname === '/feed') return this.json(res, 200, { items: await this.getFeed() });
      if (url.pathname === '/search') {
        const term = (url.searchParams.get('q') || '').trim().slice(0, 80);
        if (!term) throw new Error('请输入搜索词');
        const page = await (await this.sdk()).search(term);
        return this.json(res, 200, { items: (page.items || []).map(publicSeries) });
      }
      if (url.pathname === '/series') return this.json(res, 200, await this.getSeries(url.searchParams.get('id')));
      if (url.pathname === '/play') return this.json(res, 200, await this.resolve(url.searchParams.get('id')));
      if (url.pathname === '/media') {
        const id = url.searchParams.get('id');
        if (!validId(id)) throw new Error('无效的分集 ID');
        const filename = fs.existsSync(path.join(MEDIA_DIR, `${id}.mp4`))
          ? path.join(MEDIA_DIR, `${id}.mp4`)
          : await this.prepareMedia(id);
        return this.file(req, res, filename, 'video/mp4');
      }
      if (url.pathname === '/cover') return this.file(req, res, await this.cover(url.searchParams.get('url')), 'image/jpeg');
      return this.json(res, 404, { error: 'not found' });
    } catch (error) {
      console.error('[hongguo] request', url.pathname, error);
      if (!res.headersSent) this.json(res, 502, { error: error.message || String(error) });
      else res.destroy();
    }
  }

  listen() {
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
