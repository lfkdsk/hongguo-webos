(function () {
  'use strict';

  const CHANNELS = ['推荐', '真人剧', '漫剧'];
  const COLUMNS = 7;
  const RANGE_SIZE = 50;
  const FILL_ITEMS = COLUMNS * 3;
  const SEEK_STEP = 10;
  const SAVE_EVERY = 15;
  const SPEEDS = [1, 1.25, 1.5, 2, 0.75];
  const KEYS = { 37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'ok', 461: 'back', 27: 'back', 8: 'back', 415: 'play', 19: 'pause', 179: 'playpause', 413: 'stop', 417: 'ff', 412: 'rw' };

  const $ = (id) => document.getElementById(id);
  const state = { base: '', token: '', screen: '', series: null, episodes: [], current: -1 };
  const video = $('video');
  const historyKey = 'hongguo-webos-progress-v1';
  const speedKey = 'hongguo-webos-speed-v1';
  let history = {};
  try { history = JSON.parse(localStorage.getItem(historyKey) || '{}') || {}; } catch (_) {}
  let speed = 1;
  try { speed = SPEEDS.includes(Number(localStorage.getItem(speedKey))) ? Number(localStorage.getItem(speedKey)) : 1; } catch (_) {}

  function h(tag, props, ...children) {
    const [name, ...classes] = tag.split('.');
    const el = document.createElement(name || 'div');
    if (classes.length) el.className = classes.join(' ');
    Object.entries(props || {}).forEach(([key, value]) => {
      if (value == null || value === false) return;
      if (key === 'text') el.textContent = value;
      else if (key === 'focusable') el.setAttribute('data-f', '');
      else if (key === 'group') el.setAttribute('data-fgroup', '');
      else if (key === 'scroll') el.setAttribute('data-scroll', value);
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value);
    });
    children.flat().forEach((child) => { if (child) el.appendChild(child); });
    return el;
  }

  let toastTimer;
  function toast(message) {
    $('toast').textContent = message;
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4000);
  }
  function url(path, params) {
    const u = new URL(state.base + path);
    u.searchParams.set('token', state.token);
    Object.keys(params || {}).forEach((key) => { if (params[key]) u.searchParams.set(key, params[key]); });
    return u.toString();
  }
  async function request(path, params) {
    const response = await fetch(url(path, params));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  function clock(seconds) {
    if (!Number.isFinite(seconds)) return '00:00';
    const n = Math.floor(seconds);
    const pad = (value) => String(value).padStart(2, '0');
    const hours = Math.floor(n / 3600);
    return `${hours ? `${hours}:` : ''}${pad(Math.floor(n / 60) % 60)}:${pad(n % 60)}`;
  }

  // ---------- Focus ----------
  // Focus is virtual (the .focused class) so moving over the search box does not
  // open the TV keyboard. data-fgroup containers remember their last element.

  let focused = null;
  let focusScope = document.body;

  function canFocus(el) { return el.isConnected && el.offsetParent !== null; }
  function focusables(root) { return [...(root || focusScope).querySelectorAll('[data-f]')].filter(canFocus); }
  function setFocus(el, options) {
    if (!el) return;
    if (focused && focused !== el) focused.classList.remove('focused');
    focused = el;
    el.classList.add('focused');
    for (let group = el.parentElement.closest('[data-fgroup]'); group; group = group.parentElement && group.parentElement.closest('[data-fgroup]')) group.lastFocus = el;
    if (!options || options.scroll !== false) reveal(el, options && options.instant);
    el.dispatchEvent(new CustomEvent('focus2', { bubbles: true }));
  }
  function clearFocus() {
    if (focused) focused.classList.remove('focused');
    focused = null;
  }
  function focusInto(container, options) {
    if (!container) return false;
    const remembered = container.lastFocus;
    const target = remembered && container.contains(remembered) && canFocus(remembered) ? remembered : focusables(container)[0];
    if (target) setFocus(target, options);
    return Boolean(target);
  }
  function findNext(from, direction, list) {
    const r = from.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const group = from.closest('[data-fgroup]');
    let best = null;
    let bestScore = Infinity;
    for (const el of list) {
      if (el === from) continue;
      const b = el.getBoundingClientRect();
      const x = b.left + b.width / 2;
      const y = b.top + b.height / 2;
      let primary;
      let secondary;
      if (direction === 'left' || direction === 'right') {
        primary = direction === 'right' ? b.left - r.right : r.left - b.right;
        if (primary < -r.width * 0.3 || (direction === 'right' ? x <= cx : x >= cx)) continue;
        secondary = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top) > 0 ? 0 : Math.abs(y - cy);
      } else {
        primary = direction === 'down' ? b.top - r.bottom : r.top - b.bottom;
        if (primary < -r.height * 0.3 || (direction === 'down' ? y <= cy : y >= cy)) continue;
        secondary = Math.min(r.right, b.right) - Math.max(r.left, b.left) > 0 ? Math.abs(b.left - r.left) * 0.1 : Math.abs(x - cx);
      }
      let score = Math.max(0, primary) + secondary * 2;
      if (group && el.closest('[data-fgroup]') === group) score -= 1;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (!best) return null;
    // Entering another group returns to where it was left, if that lies this way.
    const target = best.closest('[data-fgroup]');
    const memory = target && target !== group && !target.contains(from) && target.lastFocus;
    if (memory && target.contains(memory) && canFocus(memory)) {
      const m = memory.getBoundingClientRect();
      const mx = m.left + m.width / 2;
      const my = m.top + m.height / 2;
      if (direction === 'right' ? mx > cx : direction === 'left' ? mx < cx : direction === 'down' ? my > cy : my < cy) return memory;
    }
    return best;
  }
  function move(direction) {
    if (!focused || !focusScope.contains(focused) || !canFocus(focused)) return focusInto(focusScope);
    const next = findNext(focused, direction, focusables());
    if (next) setFocus(next);
    return Boolean(next);
  }
  function reveal(el, instant) {
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      if (node.getAttribute('data-scroll') !== 'y') continue;
      const pad = 70;
      const e = el.getBoundingClientRect();
      const n = node.getBoundingClientRect();
      let top = node.scrollTop;
      if (e.top < n.top + pad) top -= n.top + pad - e.top;
      else if (e.bottom > n.bottom - pad) top += e.bottom - (n.bottom - pad);
      if (top !== node.scrollTop) node.scrollTo({ top: Math.max(0, top), behavior: instant ? 'auto' : 'smooth' });
    }
  }

  // ---------- Screens ----------

  function show(name, scope) {
    state.screen = name;
    ['home', 'series', 'player'].forEach((item) => $(`${item}-screen`).classList.toggle('hidden', item !== name));
    focusScope = scope || $(`${name}-screen`);
  }
  function stateView(kind, text, retry) {
    return h('.state', null,
      kind === 'loading' && h('.spinner'),
      h('.state-text', { text }),
      retry && h('.btn', { focusable: true, text: '重试', onclick: retry }));
  }
  function exitApp() {
    if (window.PalmSystem && window.PalmSystem.platformBack) window.PalmSystem.platformBack();
    else if (window.webOS && window.webOS.platformBack) window.webOS.platformBack();
    else window.close();
  }

  function seriesCard(item, subtitle) {
    const cover = h('.card-cover', null, h('.card-placeholder', { text: item.title || '' }));
    if (item.cover) {
      const img = h('img', { alt: '', loading: 'lazy', decoding: 'async' });
      img.addEventListener('load', () => img.classList.add('loaded'));
      img.src = url('/cover', { url: item.cover });
      cover.appendChild(img);
    }
    if (item.episodeCount) cover.appendChild(h('span.card-count', { text: `${item.episodeCount} 集` }));
    return h('.card', { focusable: true, onclick: () => openSeries(item) },
      cover,
      h('.card-title', { text: item.title || '未命名短剧' }),
      subtitle && h('.card-sub', { text: subtitle }));
  }

  // A grid that fills itself one page at a time and keeps going as focus nears
  // the end. Pages arrive seconds apart, so the first cards appear immediately.
  function pagedGrid(load, empty) {
    const grid = h('.grid', { group: true });
    const footer = h('.grid-footer');
    const box = h('div', null, grid, footer);
    const seen = new Set();
    let cursor = '';
    let more = true;
    let loading = false;
    let generation = 0;

    async function next() {
      if (loading || !more) return;
      loading = true;
      const mine = generation;
      const first = !seen.size;
      if (first) footer.replaceChildren(stateView('loading', '正在加载…'));
      try {
        const page = await load(cursor);
        if (mine !== generation) return;
        const cards = (page.items || []).filter((item) => item.id && !seen.has(item.id)).map((item) => {
          seen.add(item.id);
          return seriesCard(item);
        });
        grid.append(...cards);
        cursor = page.cursor || '';
        more = Boolean(page.hasMore && cursor);
        footer.replaceChildren();
        if (!seen.size) footer.replaceChildren(stateView('empty', empty));
        api.onload(seen.size, more);
        loading = false;
        if (more && (seen.size < FILL_ITEMS || nearEnd())) next();
      } catch (error) {
        if (mine !== generation) return;
        loading = false;
        const retry = () => { footer.replaceChildren(); next(); };
        footer.replaceChildren(stateView('error', first ? `加载失败：${error.message}` : error.message, retry));
        api.onload(seen.size, more);
      } finally {
        if (mine === generation) loading = false;
      }
    }
    function nearEnd() {
      if (!focused || focused.parentElement !== grid) return false;
      return [...grid.children].indexOf(focused) >= grid.children.length - COLUMNS * 2;
    }
    grid.addEventListener('focus2', () => { if (nearEnd()) next(); });

    const api = {
      el: box,
      grid,
      onload() {},
      next,
      reset() {
        generation++;
        seen.clear();
        cursor = '';
        more = true;
        loading = false;
        grid.replaceChildren();
        footer.replaceChildren();
        delete grid.lastFocus;
        return next();
      },
      count: () => seen.size,
    };
    return api;
  }

  // ---------- Home tabs ----------

  const tabs = [];
  let tabTimer;

  function setStatus(tab) {
    if (tabs[currentTab] === tab) $('status').textContent = tab.status || '';
  }
  function feedTab(name, index) {
    const page = h('.tab-page', { scroll: 'y' });
    const resume = h('.row');
    const grid = pagedGrid((cursor) => request('/feed', { channel: name, cursor }), '这个频道暂时没有剧集');
    const tab = { el: page, status: '', activated: false };
    grid.onload = (count) => {
      tab.status = `${count} 部`;
      setStatus(tab);
    };
    page.append(index === 0 ? resume : '', grid.el);
    tab.activate = () => {
      if (!tab.activated) { tab.activated = true; grid.next(); }
      if (index === 0) renderResume(resume);
    };
    tab.refresh = () => grid.reset();
    return tab;
  }
  function renderResume(box) {
    const rows = Object.entries(history)
      .filter(([, entry]) => entry.title)
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .slice(0, COLUMNS);
    if (!rows.length) return box.replaceChildren();
    const cards = rows.map(([id, entry]) => seriesCard({ id, title: entry.title, cover: entry.cover, episodeCount: entry.episodeCount, description: entry.description }, entry.number ? `看到第 ${entry.number} 集` : '继续观看'));
    box.replaceChildren(h('.row-title', { text: '继续观看' }), h('.grid', { group: true }, cards));
  }
  function searchTab() {
    const input = h('input.search-input', { type: 'text', placeholder: '输入剧名，按 OK 打开键盘', focusable: true, 'aria-label': '搜索短剧' });
    input.addEventListener('click', () => input.focus());
    input.addEventListener('submit2', () => run(input.value));
    const title = h('.row-title.hidden');
    let term = '';
    const grid = pagedGrid((cursor) => request('/search', { q: term, cursor }), '没有找到相关短剧');
    const page = h('.tab-page', { scroll: 'y' }, h('.search-bar', null, input), title, grid.el);
    const tab = { el: page, status: '' };
    grid.onload = (count) => {
      tab.status = term ? `${count} 条结果` : '';
      setStatus(tab);
      if (tab.pendingFocus && count) {
        tab.pendingFocus = false;
        setFocus(grid.grid.firstElementChild);
      }
    };
    function run(value) {
      term = value.trim();
      input.value = term;
      if (!term) return;
      title.textContent = `搜索：${term}`;
      title.classList.remove('hidden');
      tab.pendingFocus = true;
      grid.reset();
    }
    tab.activate = () => {};
    tab.refresh = () => { if (term) grid.reset(); };
    return tab;
  }

  let currentTab = -1;
  function selectTab(index) {
    if (index === currentTab) return;
    currentTab = index;
    tabs.forEach((tab, i) => {
      tab.button.classList.toggle('active', i === index);
      tab.el.classList.toggle('hidden', i !== index);
    });
    tabs[index].activate();
    setStatus(tabs[index]);
  }
  function buildHome() {
    CHANNELS.forEach((name, index) => tabs.push(Object.assign(feedTab(name, index), { name })));
    tabs.push(Object.assign(searchTab(), { name: '搜索' }));
    tabs.forEach((tab, index) => {
      tab.button = h('.tab', { focusable: true, text: tab.name, 'data-i': index, onclick: () => { selectTab(index); focusInto(tab.el); } });
      $('tabs').appendChild(tab.button);
      tab.el.classList.add('hidden');
      $('tab-host').appendChild(tab.el);
    });
    // Switching on focus is debounced so sweeping across tabs loads nothing.
    $('tabs').addEventListener('focus2', (event) => {
      const index = Number(event.target.getAttribute('data-i'));
      clearTimeout(tabTimer);
      tabTimer = setTimeout(() => selectTab(index), 220);
    });
  }
  function homeKey(key) {
    const onTabs = focused && $('tabs').contains(focused);
    if (key === 'down' && onTabs) {
      clearTimeout(tabTimer);
      const index = Number(focused.getAttribute('data-i'));
      selectTab(index);
      focusInto(tabs[index].el);
      return true;
    }
    if (key === 'back') {
      if (onTabs) exitApp();
      else setFocus(tabs[currentTab].button);
      return true;
    }
    if (key === 'play' || key === 'playpause') {
      if (tabs[currentTab].refresh) { tabs[currentTab].refresh(); toast('正在刷新'); }
      return true;
    }
    return false;
  }
  function backToHome() {
    show('home');
    if (currentTab === 0) renderResumeBox();
    if (state.homeFocus && state.homeFocus.isConnected) setFocus(state.homeFocus, { instant: true });
    else setFocus(tabs[currentTab].button);
  }
  function renderResumeBox() {
    const box = tabs[0].el.querySelector('.row');
    const keep = state.homeFocus && box.contains(state.homeFocus);
    renderResume(box);
    if (keep) state.homeFocus = box.querySelector('[data-f]');
  }

  // ---------- Series ----------

  function entryOf(id) { return history[id] || null; }
  function episodeLabel(episode, index) { return episode.title || `第 ${episode.number || index + 1} 集`; }

  // Hundreds of episodes are normal here; only one range is ever on screen.
  function episodeBrowser(onPick, currentIndex) {
    const chips = h('.chip-row', { group: true });
    const grid = h('.episode-grid', { group: true });
    const count = state.episodes.length;
    const ranges = Math.ceil(count / RANGE_SIZE);
    const saved = state.series && entryOf(state.series.id);
    let active = -1;
    function render(range) {
      if (range === active) return;
      active = range;
      [...chips.children].forEach((chip, i) => chip.classList.toggle('active', i === range));
      const start = range * RANGE_SIZE;
      grid.replaceChildren(...state.episodes.slice(start, start + RANGE_SIZE).map((episode, offset) => {
        const index = start + offset;
        const isCurrent = index === currentIndex;
        return h(`.episode${isCurrent ? '.current' : ''}${episode.playable ? '' : '.disabled'}`, {
          focusable: episode.playable,
          'aria-label': episodeLabel(episode, index),
          onclick: () => onPick(index),
        },
        h('span', { text: String(episode.number || index + 1) }),
        !isCurrent && saved && saved.episodeId === episode.id && h('span.episode-mark', { text: '上次' }));
      }));
      delete grid.lastFocus;
    }
    if (ranges > 1) {
      for (let range = 0; range < ranges; range++) {
        const first = range * RANGE_SIZE + 1;
        chips.appendChild(h('.chip', {
          focusable: true,
          text: `${first}-${Math.min(first + RANGE_SIZE - 1, count)}`,
          onclick: () => render(range),
        }));
      }
      chips.addEventListener('focus2', (event) => render([...chips.children].indexOf(event.target)));
    }
    render(Math.max(0, Math.floor(Math.max(currentIndex, 0) / RANGE_SIZE)));
    return {
      el: h('div', null, ranges > 1 && chips, grid),
      focusCurrent() {
        const target = grid.children[Math.max(currentIndex, 0) % RANGE_SIZE];
        setFocus(target && target.hasAttribute('data-f') ? target : focusables(grid)[0]);
      },
    };
  }

  let seriesRequest = 0;
  function renderSeries(item, episodes, error) {
    const saved = entryOf(item.id);
    const resumeIndex = saved ? episodes.findIndex((episode) => episode.id === saved.episodeId) : -1;
    const firstPlayable = episodes.findIndex((episode) => episode.playable);
    const meta = [episodes.length ? `共 ${episodes.length} 集` : item.episodeCount ? `共 ${item.episodeCount} 集` : ''];
    if (resumeIndex >= 0) meta.push(`上次看到第 ${episodes[resumeIndex].number || resumeIndex + 1} 集 ${clock(saved.time)}`);
    const actions = h('.action-row', { group: true });
    if (resumeIndex >= 0) actions.appendChild(h('.btn.btn-primary', { focusable: true, text: `继续第 ${episodes[resumeIndex].number || resumeIndex + 1} 集`, onclick: () => play(resumeIndex) }));
    if (firstPlayable >= 0) actions.appendChild(h(`.btn${resumeIndex >= 0 ? '' : '.btn-primary'}`, { focusable: true, text: resumeIndex >= 0 ? '从头播放' : '开始播放', onclick: () => play(firstPlayable, 0) }));
    const cover = h('.series-cover');
    if (item.cover) cover.appendChild(h('img', { alt: '', src: url('/cover', { url: item.cover }) }));
    const hero = h('.series-hero', null, cover, h('.series-info', null,
      h('.series-title', { text: item.title || '短剧' }),
      h('.series-meta', { text: meta.filter(Boolean).join(' · ') }),
      item.description && h('.series-desc', { text: item.description }),
      actions));
    const screen = $('series-screen');
    if (error) {
      screen.replaceChildren(hero, stateView('error', `加载分集失败：${error}`, () => openSeries(item)));
      return setFocus(focusables(screen)[0]);
    }
    if (!episodes.length) {
      return screen.replaceChildren(hero, stateView('loading', '正在加载分集…'));
    }
    const browser = episodeBrowser((index) => play(index), resumeIndex);
    screen.replaceChildren(hero, h('.section-head', { text: `选集 (${episodes.length})` }), browser.el);
    screen.scrollTop = 0;
    focusInto(actions);
  }
  async function openSeries(item) {
    if (state.screen === 'home') state.homeFocus = focused;
    const mine = ++seriesRequest;
    state.series = item;
    state.episodes = [];
    show('series');
    clearFocus();
    renderSeries(item, []);
    try {
      const data = await request('/series', { id: item.id });
      if (mine !== seriesRequest) return;
      state.series = Object.assign({}, item, {
        title: item.title || data.series.title,
        description: item.description || data.series.description,
        cover: item.cover || data.series.cover,
        episodeCount: item.episodeCount || data.series.episodeCount || data.episodes.length,
      });
      state.episodes = data.episodes;
      renderSeries(state.series, data.episodes);
    } catch (error) {
      if (mine === seriesRequest) renderSeries(item, [], error.message);
    }
  }

  // ---------- Player ----------

  let playRequest = 0;
  let progressTimer;
  let osdTimer;
  let seekTimer;
  let pendingSeek = null;
  let lastSaved = 0;
  let panelOpen = false;
  let loadFailed = false;

  function remember() {
    if (!state.series || state.current < 0) return;
    const episode = state.episodes[state.current];
    if (!episode) return;
    const series = state.series;
    history[series.id] = {
      episodeId: episode.id,
      time: Math.floor(video.currentTime || 0),
      number: episode.number || state.current + 1,
      title: series.title,
      cover: series.cover,
      description: series.description,
      episodeCount: series.episodeCount,
      at: Date.now(),
    };
    try { localStorage.setItem(historyKey, JSON.stringify(history)); } catch (_) {}
  }
  function silence() {
    clearTimeout(progressTimer);
    video.pause();
    video.onloadedmetadata = null;
    video.removeAttribute('src');
    video.load();
  }
  function setLoading(text, isError) {
    const box = $('player-loading');
    box.classList.toggle('hidden', !text);
    box.classList.toggle('error', Boolean(isError));
    $('loading-text').textContent = text || '';
    $('loading-hint').classList.toggle('hidden', !isError);
    loadFailed = Boolean(isError);
    if (isError) $('osd').classList.remove('show');
  }
  function showOsd(sticky) {
    $('osd').classList.add('show');
    clearTimeout(osdTimer);
    if (!sticky) osdTimer = setTimeout(() => { if (!video.paused) $('osd').classList.remove('show'); }, 4000);
    paintOsd();
  }
  function paintOsd() {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const now = pendingSeek != null ? pendingSeek : video.currentTime;
    const percent = (value) => (duration ? `${Math.min(100, (value / duration) * 100)}%` : '0');
    $('osd-fill').style.width = percent(now);
    const buffered = video.buffered;
    $('osd-buffer').style.width = percent(buffered.length ? buffered.end(buffered.length - 1) : 0);
    $('osd-seek').style.left = percent(now);
    $('osd-seek').classList.toggle('hidden', pendingSeek == null);
    $('osd-time').textContent = clock(now);
    $('osd-duration').textContent = clock(duration);
  }
  function seekBy(delta) {
    if (!Number.isFinite(video.duration)) return;
    const from = pendingSeek != null ? pendingSeek : video.currentTime;
    pendingSeek = Math.max(0, Math.min(video.duration - 1, from + delta));
    showOsd(true);
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => {
      video.currentTime = pendingSeek;
      pendingSeek = null;
      showOsd();
    }, 500);
  }
  function applySpeed() {
    video.defaultPlaybackRate = speed;
    video.playbackRate = speed;
    $('osd-speed').textContent = speed === 1 ? '' : `${speed}×`;
  }
  function cycleSpeed() {
    speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    try { localStorage.setItem(speedKey, String(speed)); } catch (_) {}
    applySpeed();
    toast(`${speed}× 倍速`);
    showOsd();
  }
  function togglePlay() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    showOsd(true);
  }
  function followProgress(id, mine) {
    return new Promise((resolve, reject) => {
      const poll = async () => {
        if (mine !== playRequest) return;
        try {
          const status = await request('/progress', { id });
          if (mine !== playRequest) return;
          if (status.stage === 'ready') return resolve();
          if (status.stage === 'failed') return reject(new Error(status.error || '视频准备失败'));
          if (status.stage === 'downloading') {
            const mb = (bytes) => (bytes / 1048576).toFixed(1);
            setLoading(status.total ? `正在下载 ${mb(status.received)} / ${mb(status.total)} MB` : '正在下载视频…');
          } else if (status.stage === 'processing') setLoading('正在处理视频…');
          progressTimer = setTimeout(poll, 500);
        } catch (error) { reject(error); }
      };
      poll();
    });
  }
  async function play(index, startAt) {
    const episode = state.episodes[index];
    if (!episode) return;
    const mine = ++playRequest;
    if (state.screen === 'series') state.seriesFocus = focused;
    closePanel();
    silence();
    state.current = index;
    lastSaved = 0;
    $('osd-title').textContent = state.series.title || '';
    $('osd-episode').textContent = episodeLabel(episode, index);
    show('player');
    clearFocus();
    setLoading('正在获取播放地址…');
    showOsd();
    const saved = entryOf(state.series.id);
    const resume = startAt != null ? startAt : saved && saved.episodeId === episode.id ? saved.time : 0;
    try {
      const data = await request('/play', { id: episode.id });
      if (mine !== playRequest) return;
      await followProgress(episode.id, mine);
      if (mine !== playRequest) return;
      setLoading('正在打开视频…');
      video.onloadedmetadata = () => {
        video.onloadedmetadata = null;
        applySpeed();
        if (resume > 0 && resume < video.duration - 10) video.currentTime = resume;
        setLoading('');
        remember();
        video.play().catch(() => {});
        showOsd();
      };
      video.src = url(data.mediaPath);
      video.load();
    } catch (error) {
      if (mine === playRequest) setLoading(error.message, true);
    }
  }
  function leavePlayer() {
    ++playRequest;
    remember();
    closePanel();
    silence();
    setLoading('');
    show('series');
    renderSeries(state.series, state.episodes);
    const browserTarget = focusables($('series-screen'))[0];
    if (browserTarget) focusInto($('series-screen').querySelector('.action-row') || browserTarget, { instant: true });
  }
  function openPanel() {
    panelOpen = true;
    const panel = $('episode-panel');
    const browser = episodeBrowser((index) => play(index, 0), state.current);
    panel.replaceChildren(h('.panel-scroll', { scroll: 'y' }, h('.section-head', { text: `选集 (${state.episodes.length})` }), browser.el));
    panel.classList.remove('hidden');
    focusScope = panel;
    browser.focusCurrent();
    showOsd(true);
  }
  function closePanel() {
    if (!panelOpen) return;
    panelOpen = false;
    $('episode-panel').classList.add('hidden');
    $('episode-panel').replaceChildren();
    focusScope = $('player-screen');
    clearFocus();
    showOsd();
  }
  function playerKey(key) {
    if (panelOpen) {
      if (key === 'back') { closePanel(); return true; }
      return false;
    }
    if (loadFailed) {
      if (key === 'ok') { play(state.current); return true; }
      if (key === 'back') { leavePlayer(); return true; }
      return true;
    }
    switch (key) {
      case 'ok': case 'playpause': togglePlay(); return true;
      case 'play': video.play().catch(() => {}); showOsd(); return true;
      case 'pause': video.pause(); showOsd(true); return true;
      case 'left': case 'rw': seekBy(-SEEK_STEP); return true;
      case 'right': case 'ff': seekBy(SEEK_STEP); return true;
      case 'up': cycleSpeed(); return true;
      case 'down': openPanel(); return true;
      case 'back': case 'stop': leavePlayer(); return true;
      default: return true;
    }
  }

  // ---------- Remote control ----------

  function onKeyDown(event) {
    const key = KEYS[event.keyCode];
    const active = document.activeElement;
    if (active && active.tagName === 'INPUT') {
      if (event.keyCode === 8) return;
      if (key === 'ok') {
        event.preventDefault();
        active.dispatchEvent(new CustomEvent('submit2'));
        active.blur();
      } else if (key === 'back' || key === 'up' || key === 'down') {
        active.blur();
        if (key === 'back') event.preventDefault();
        else move(key);
      }
      return;
    }
    if (!key || !state.screen) return;
    event.preventDefault();
    if (state.screen === 'player' && playerKey(key)) return;
    if (state.screen === 'home' && homeKey(key)) return;
    if (key === 'ok') {
      if (focused && focusScope.contains(focused)) focused.click();
    } else if (key === 'back') {
      backToHome();
    } else if (['left', 'right', 'up', 'down'].includes(key)) {
      move(key);
    }
  }

  // ---------- Startup ----------

  function start() {
    buildHome();
    $('splash').remove();
    show('home');
    selectTab(0);
    setFocus(tabs[0].button, { instant: true });
  }
  function connect() {
    const params = new URLSearchParams(location.search);
    if (params.get('base')) {
      state.base = params.get('base');
      state.token = params.get('token');
      return start();
    }
    if (!window.webOS || !webOS.service || !webOS.service.request) { $('splash-text').textContent = '请在 LG webOS 电视上启动此应用'; return; }
    webOS.service.request('luna://com.lfkdsk.hongguo.service/', {
      method: 'ping',
      parameters: {},
      onSuccess: (data) => {
        if (!data.returnValue) { $('splash-text').textContent = data.errorText || '电视服务启动失败'; return; }
        state.base = `http://127.0.0.1:${data.port}`;
        state.token = data.token;
        start();
      },
      onFailure: (error) => { $('splash-text').textContent = error.errorText || '电视服务无法启动'; },
    });
  }

  video.addEventListener('timeupdate', () => {
    if ($('osd').classList.contains('show')) paintOsd();
    if (Math.abs(video.currentTime - lastSaved) >= SAVE_EVERY) {
      lastSaved = video.currentTime;
      remember();
    }
  });
  video.addEventListener('pause', () => { if (state.screen === 'player') showOsd(true); });
  video.addEventListener('play', () => showOsd());
  video.addEventListener('ended', () => {
    remember();
    let next = state.current + 1;
    while (next < state.episodes.length && !state.episodes[next].playable) next++;
    if (next < state.episodes.length) play(next, 0);
    else { toast('已经是最后一集'); leavePlayer(); }
  });
  video.addEventListener('error', () => {
    if (!video.getAttribute('src')) return;
    setLoading('电视无法播放这个视频，请换一集试试', true);
  });
  document.addEventListener('keydown', onKeyDown, true);
  // The Magic Remote pointer moves focus by hovering and acts by clicking.
  let pointerX = -1;
  let pointerY = -1;
  document.addEventListener('mouseover', (event) => {
    // Cards loading under a resting pointer fire this too; only real movement counts.
    if (event.screenX === pointerX && event.screenY === pointerY) return;
    pointerX = event.screenX;
    pointerY = event.screenY;
    const target = event.target.closest && event.target.closest('[data-f]');
    if (target && target !== focused && focusScope.contains(target)) setFocus(target, { scroll: false });
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && !video.paused) video.pause(); });
  // handlesRelaunch leaves the window where it is, so opening the app from the
  // launcher while it runs in the background has to bring it forward itself.
  document.addEventListener('webOSRelaunch', () => { if (window.PalmSystem && window.PalmSystem.activate) window.PalmSystem.activate(); });
  window.addEventListener('beforeunload', () => {
    remember();
    if (window.webOS && webOS.service && webOS.service.request) webOS.service.request('luna://com.lfkdsk.hongguo.service/', { method: 'stop', parameters: {} });
  });
  connect();
})();
