(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = { base: '', token: '', items: [], series: null, episodes: [], current: -1, screen: 'home' };
  const video = $('video');
  const historyKey = 'hongguo-webos-progress-v1';
  let history = {};
  try { history = JSON.parse(localStorage.getItem(historyKey) || '{}') || {}; } catch (_) {}

  function setStatus(value) { $('status').textContent = value; }
  function toast(message) {
    $('toast').textContent = message;
    $('toast').classList.add('visible');
    setTimeout(() => $('toast').classList.remove('visible'), 5000);
  }
  function url(path, params) {
    const u = new URL(state.base + path);
    u.searchParams.set('token', state.token);
    Object.keys(params || {}).forEach((key) => u.searchParams.set(key, params[key]));
    return u.toString();
  }
  async function request(path, params) {
    const response = await fetch(url(path, params));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  function screen(name) {
    state.screen = name;
    ['home', 'series', 'player'].forEach((item) => $(`${item}-screen`).classList.toggle('hidden', item !== name));
  }
  function firstFocus() {
    const first = document.querySelector(`#${state.screen}-screen button:not(:disabled)`);
    if (first) first.focus();
  }
  function remember() {
    if (!state.series || state.current < 0) return;
    const episode = state.episodes[state.current];
    history[state.series.id] = { episodeId: episode.id, time: Math.floor(video.currentTime || 0) };
    localStorage.setItem(historyKey, JSON.stringify(history));
  }
  function card(item) {
    const button = document.createElement('button');
    button.className = 'card';
    button.setAttribute('aria-label', item.title);
    if (item.cover) {
      const img = document.createElement('img');
      img.src = url('/cover', { url: item.cover });
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => img.style.visibility = 'hidden';
      button.appendChild(img);
    } else {
      const placeholder = document.createElement('span');
      placeholder.className = 'no-cover';
      placeholder.textContent = '▶';
      button.appendChild(placeholder);
    }
    const title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = item.title || '未命名短剧';
    button.appendChild(title);
    const meta = document.createElement('span');
    meta.className = 'card-meta';
    meta.textContent = item.episodeCount ? `${item.episodeCount} 集` : '查看分集';
    button.appendChild(meta);
    button.addEventListener('click', () => openSeries(item));
    return button;
  }
  function showCatalog(items, title) {
    state.items = items;
    $('home-title').textContent = title;
    $('catalog').replaceChildren(...items.map(card));
    screen('home');
    firstFocus();
  }
  async function feed() {
    setStatus('正在加载推荐…');
    try {
      const data = await request('/feed');
      showCatalog(data.items, '推荐短剧');
      setStatus(`${data.items.length} 部短剧`);
    } catch (error) { setStatus('加载失败'); toast(error.message); }
  }
  async function search() {
    const q = $('search-input').value.trim();
    if (!q) return feed();
    setStatus('正在搜索…');
    try {
      const data = await request('/search', { q });
      showCatalog(data.items, `搜索：${q}`);
      setStatus(`${data.items.length} 条结果`);
    } catch (error) { setStatus('搜索失败'); toast(error.message); }
  }
  async function openSeries(item) {
    state.series = item;
    $('series-title').textContent = item.title || '短剧';
    $('series-description').textContent = item.description || '';
    $('episodes').replaceChildren();
    screen('series');
    setStatus('正在加载分集…');
    try {
      const data = await request('/series', { id: item.id });
      state.episodes = data.episodes;
      const saved = history[item.id];
      const buttons = data.episodes.map((episode, index) => {
        const button = document.createElement('button');
        button.className = 'episode' + (saved?.episodeId === episode.id ? ' continue' : '');
        button.textContent = episode.title || `第 ${episode.number || index + 1} 集`;
        button.disabled = !episode.playable;
        button.addEventListener('click', () => play(index));
        return button;
      });
      $('episodes').replaceChildren(...buttons);
      setStatus(`${buttons.length} 集`);
      (buttons.find((button) => button.classList.contains('continue')) || buttons[0] || $('series-back')).focus();
    } catch (error) { setStatus('加载分集失败'); toast(error.message); }
  }
  function format(seconds) {
    if (!Number.isFinite(seconds)) return '00:00';
    const n = Math.floor(seconds);
    return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  }
  async function play(index) {
    const episode = state.episodes[index];
    if (!episode) return;
    video.pause();
    video.removeAttribute('src');
    video.load();
    state.current = index;
    $('player-title').textContent = state.series.title;
    $('player-episode').textContent = episode.title || `第 ${episode.number || index + 1} 集`;
    $('player-message').textContent = '';
    $('video-loading').textContent = '正在准备视频…';
    $('video-loading').classList.remove('hidden');
    $('next-episode').disabled = index >= state.episodes.length - 1;
    screen('player');
    $('toggle-play').focus();
    try {
      const data = await request('/play', { id: episode.id });
      video.src = url(data.mediaPath);
      video.load();
      const saved = history[state.series.id];
      video.onloadedmetadata = () => {
        if (saved?.episodeId === episode.id && saved.time > 0 && saved.time < video.duration - 10) video.currentTime = saved.time;
        $('video-loading').classList.add('hidden');
        video.play().catch(() => {});
      };
    } catch (error) {
      $('video-loading').textContent = error.message;
      toast(error.message);
    }
  }
  function back() {
    if (state.screen === 'player') {
      remember();
      video.pause();
      video.removeAttribute('src');
      video.load();
      screen('series');
      firstFocus();
    } else if (state.screen === 'series') {
      screen('home');
      firstFocus();
    }
  }
  function moveFocus(key) {
    const nodes = [...document.querySelectorAll('button:not(:disabled), input')].filter((node) => node.offsetParent !== null);
    const current = document.activeElement;
    const origin = current?.getBoundingClientRect();
    if (!origin) return;
    const cx = origin.left + origin.width / 2;
    const cy = origin.top + origin.height / 2;
    const target = nodes.filter((node) => node !== current).map((node) => {
      const box = node.getBoundingClientRect();
      const dx = box.left + box.width / 2 - cx;
      const dy = box.top + box.height / 2 - cy;
      const forward = key === 'ArrowRight' ? dx > 5 : key === 'ArrowLeft' ? dx < -5 : key === 'ArrowDown' ? dy > 5 : dy < -5;
      const primary = key === 'ArrowLeft' || key === 'ArrowRight' ? Math.abs(dx) : Math.abs(dy);
      const secondary = key === 'ArrowLeft' || key === 'ArrowRight' ? Math.abs(dy) : Math.abs(dx);
      return { node, score: forward ? primary + secondary * 3 : Infinity };
    }).sort((a, b) => a.score - b.score)[0];
    if (target && Number.isFinite(target.score)) target.node.focus();
  }
  function connect() {
    if (!window.webOS?.service?.request) { setStatus('webOS API 不可用'); return toast('请在 LG webOS 电视上启动此应用'); }
    webOS.service.request('luna://com.lfkdsk.hongguo.service/', {
      method: 'ping', parameters: {},
      onSuccess: (data) => {
        if (!data.returnValue) return toast(data.errorText || '电视服务启动失败');
        state.base = `http://127.0.0.1:${data.port}`;
        state.token = data.token;
        feed();
      },
      onFailure: (error) => { setStatus('连接失败'); toast(error.errorText || '电视服务无法启动'); },
    });
  }

  $('search-button').addEventListener('click', search);
  $('search-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') search(); });
  $('series-back').addEventListener('click', back);
  $('player-back').addEventListener('click', back);
  $('toggle-play').addEventListener('click', () => video.paused ? video.play() : video.pause());
  $('seek-back').addEventListener('click', () => { video.currentTime = Math.max(0, video.currentTime - 15); });
  $('seek-forward').addEventListener('click', () => { video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 15); });
  $('next-episode').addEventListener('click', () => play(state.current + 1));
  video.addEventListener('timeupdate', () => {
    $('clock').textContent = `${format(video.currentTime)} / ${format(video.duration)}`;
    if (Math.floor(video.currentTime) % 5 === 0) remember();
  });
  video.addEventListener('play', () => { $('toggle-play').textContent = '暂停'; });
  video.addEventListener('pause', () => { $('toggle-play').textContent = '播放'; });
  video.addEventListener('ended', () => { remember(); if (state.current + 1 < state.episodes.length) play(state.current + 1); });
  video.addEventListener('error', () => { $('video-loading').textContent = '播放失败，请重试或换一集'; $('video-loading').classList.remove('hidden'); });
  document.addEventListener('keydown', (event) => {
    if (['Escape', 'Backspace'].includes(event.key) || event.keyCode === 461) { event.preventDefault(); back(); return; }
    if (state.screen === 'player' && !['INPUT', 'BUTTON'].includes(document.activeElement.tagName)) {
      if (event.key === 'ArrowLeft') { event.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 15); return; }
      if (event.key === 'ArrowRight') { event.preventDefault(); video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 15); return; }
    }
    if (event.key.startsWith('Arrow') && document.activeElement.tagName !== 'INPUT') { event.preventDefault(); moveFocus(event.key); }
  });
  window.addEventListener('beforeunload', () => {
    remember();
    if (window.webOS?.service?.request) webOS.service.request('luna://com.lfkdsk.hongguo.service/', { method: 'stop', parameters: {} });
  });
  connect();
})();
