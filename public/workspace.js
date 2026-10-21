/* MemVault server workspace: the Server, Terminal and Files tabs.
   Same rules as app.js: dynamic text goes through esc(), no inline handlers or styles (strict CSP),
   and the key is the one app.js keeps (sessionStorage, or a paired device's own key). */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const read = (k, area) => { try { return window[area].getItem(k); } catch { return null; } };
  const getToken = () => read('memvault-token', 'sessionStorage') || read('memvault-device-key', 'localStorage');

  async function api(path, { method = 'GET', body, signal } = {}) {
    const headers = {};
    const t = getToken();
    if (t) headers.authorization = `Bearer ${t}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(path, { method, headers, signal, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || 'That did not work.'); e.status = res.status; e.data = data; throw e; }
    return data;
  }

  /* ───────── which machine ───────── */
  // '' is this machine; anything else is a linked one, reached through this server (machines.mjs).
  const MACHINE_KEY = 'memvault-machine';
  let machine = read(MACHINE_KEY, 'localStorage') || '';
  let machines = [];
  const wapi = (path, opts) => api(machine ? `/api/machines/${encodeURIComponent(machine)}/relay${path}` : path, opts);
  const machineName = () => (machine ? machines.find((m) => m.id === machine)?.name || 'that machine' : 'this machine');

  const bytes = (n) => {
    if (n == null) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
  };
  const dur = (s) => {
    s = Math.floor(s);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  };
  const say = (msg) => { const t = $('#toast'); if (!t) return; t.textContent = msg; try { t.showPopover(); setTimeout(() => t.hidePopover(), 3500); } catch { /* no popover */ } };

  let caps = null;      // what the chosen machine offers
  let localCaps = null; // what this machine offers
  async function detect() {
    if (!getToken()) return;
    try {
      const [l, m] = await Promise.all([api('/api/workspace'), api('/api/machines')]);
      localCaps = l; machines = m.machines;
    } catch { return; }
    if (machine && !machines.some((x) => x.id === machine)) setMachine('');
    renderPicker();
    await loadCaps();
  }

  async function loadCaps() {
    caps = machine ? await wapi('/api/workspace').catch((e) => ({ enabled: false, error: e.message })) : localCaps;
    document.querySelectorAll('.tab[data-ws]').forEach((t) => {
      t.hidden = t.dataset.ws === 'server' ? false : !(caps?.[t.dataset.ws]); // Server always: it is where machines are linked
    });
  }

  function renderPicker() {
    const sel = $('#ws-machine');
    const here = `This machine${localCaps?.enabled ? '' : ' (workspace off)'}`;
    sel.innerHTML = `<option value="">${esc(here)}</option>` + machines.map((m) => `<option value="${esc(m.id)}">${esc(m.name)} · ${esc(m.url.replace(/^https?:\/\//, ''))}</option>`).join('');
    sel.value = machine;
    $('#ws-machine-remove').hidden = !machine;
  }

  function setMachine(id) {
    machine = id;
    try { if (id) localStorage.setItem(MACHINE_KEY, id); else localStorage.removeItem(MACHINE_KEY); } catch { /* storage blocked */ }
  }

  // Shown on a tab when the chosen machine does not offer it.
  function offNotice(box, what) {
    const why = caps?.error ? caps.error : machine
      ? `${machineName()} has its ${what} turned off. Turn it on there (docs/workspace.md).`
      : `The server workspace is off on this machine. Turn it on with "security": { "workspace": { "enabled": true } } in ~/.memvaultrc.json, or link another machine above.`;
    box.innerHTML = `<div class="card ws-off"><p>${esc(why)}</p></div>`;
  }

  /* ───────── server ───────── */
  let svTimer = null;
  const meter = (label, pct, main, sub) => `<div class="card ws-meter${pct >= 90 ? ' hot' : ''}"><div class="label">${esc(label)}</div><div class="value">${esc(main)}</div>`
    + `${pct == null ? '' : `<progress max="100" value="${esc(pct)}" aria-label="${esc(label)} ${esc(pct)}%">${esc(pct)}%</progress>`}<small>${esc(sub)}</small></div>`;

  async function loadStatus() {
    const s = await wapi('/api/system/status');
    $('#sv-host').textContent = `${machine ? `${machineName()} — ` : ''}${s.hostname} · ${s.platform}`;
    $('#sv-meters').innerHTML = meter('CPU', s.cpu.percent, `${s.cpu.percent}%`, `${s.cpu.cores} cores · load ${s.cpu.load.map((x) => x.toFixed(2)).join(' ')}`)
      + meter('Memory', s.memory.percent, `${s.memory.percent}%`, `${bytes(s.memory.used)} used · ${bytes(s.memory.free)} free`)
      + (s.disk ? meter('Disk', s.disk.percent, `${s.disk.percent}%`, `${bytes(s.disk.used)} of ${bytes(s.disk.total)}`) : meter('Disk', null, '—', 'Not available'))
      + meter('Uptime', null, dur(s.uptime), 'since last boot');
  }

  const procCard = (p) => {
    const on = p.online;
    const meta = p.kind === 'pm2'
      ? `PM2 · CPU ${p.cpu ?? '—'}% · ${bytes(p.memory)} · ${p.restarts} restarts${p.uptime ? ` · up ${dur(p.uptime / 1000)}` : ''}`
      : `Docker · ${p.image} · ${p.status}`;
    const b = (action, label, cls = '') => `<button class="btn sm ${cls}" data-action="ws-proc" data-op="${action}" data-kind="${esc(p.kind)}" data-name="${esc(p.name)}">${label}</button>`;
    return `<div class="card ws-proc"><div class="row between gap"><h4>${esc(p.name)}</h4><span class="ws-badge ${on ? 'on' : 'off'}">${on ? '🟢 Online' : '🔴 Stopped'}</span></div>`
      + `<div class="meta">${esc(meta)}</div><div class="row">${b('restart', 'Restart', 'primary')}${on ? b('stop', 'Stop') : b('start', 'Start')}`
      + `<button class="btn sm ghost" data-action="ws-logs" data-kind="${esc(p.kind)}" data-name="${esc(p.name)}">Logs</button></div></div>`;
  };

  async function loadProcs() {
    if (!caps?.processes) { offNotice($('#sv-procs'), 'service controls'); return; }
    const r = await wapi('/api/system/processes');
    let html = '';
    if (r.pm2.available) html += `<h4 class="ws-group">PM2 apps (${r.pm2.apps.length})</h4>` + (r.pm2.apps.map(procCard).join('') || '<p class="muted">No PM2 apps.</p>');
    if (r.docker.available) html += `<h4 class="ws-group">Docker containers (${r.docker.containers.length})</h4>` + (r.docker.containers.map(procCard).join('') || '<p class="muted">No containers.</p>');
    $('#sv-procs').innerHTML = html || '<p class="muted">Neither PM2 nor Docker was found on this server.</p>';
  }

  async function loadServer() {
    stopServer();
    if (!caps?.enabled) { $('#sv-meters').innerHTML = ''; $('#sv-host').textContent = machineName(); offNotice($('#sv-procs'), 'server workspace'); return; }
    const tick = async () => {
      try { await Promise.all([loadStatus(), loadProcs()]); } catch (e) { $('#sv-procs').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
      if (!$('#view-server').hidden && $('#sv-auto').checked) svTimer = setTimeout(tick, 5000);
    };
    tick();
  }
  function stopServer() { clearTimeout(svTimer); svTimer = null; }

  async function procAction(el) {
    const { op, kind, name } = el.dataset;
    if (op !== 'start' && !window.confirm(`${op === 'stop' ? 'Stop' : 'Restart'} ${name}?`)) return;
    el.disabled = true;
    try { await wapi(`/api/system/process/${op}`, { method: 'POST', body: { kind, name } }); say(`${name}: ${op} done.`); }
    catch (e) { say(`${name}: ${e.message}`); }
    finally { el.disabled = false; loadProcs().catch(() => {}); }
  }

  async function showLogs(el) {
    const { kind, name } = el.dataset;
    $('#sv-logs-card').hidden = false;
    $('#sv-logs-title').textContent = `Logs: ${name}`;
    $('#sv-logs').textContent = 'Loading…';
    try {
      const r = await wapi(`/api/system/process/${encodeURIComponent(name)}/logs?kind=${encodeURIComponent(kind)}&lines=300`);
      const pre = $('#sv-logs');
      pre.textContent = r.lines.join('\n') || '(no output)';
      pre.scrollTop = pre.scrollHeight;
      $('#sv-logs-card').scrollIntoView({ block: 'nearest' });
    } catch (e) { $('#sv-logs').textContent = e.message; }
  }

  /* ───────── terminal ───────── */
  const term = { xt: null, fit: null, id: null, seq: 0, abort: null, queue: '', sending: false, mode: '' };

  function ensureXterm() {
    if (term.xt || !window.Terminal) return term.xt;
    const dark = { background: '#121212', foreground: '#e8e6e3', cursor: '#ff7a3d' };
    term.xt = new window.Terminal({ cursorBlink: true, convertEol: false, fontSize: window.innerWidth < 560 ? 12 : 14, fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', theme: dark, scrollback: 5000 });
    if (window.FitAddon) { term.fit = new window.FitAddon.FitAddon(); term.xt.loadAddon(term.fit); }
    term.xt.open($('#term'));
    term.xt.onData((d) => send(d));
    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(fitNow, 150); });
    return term.xt;
  }

  function fitNow() {
    if (!term.fit || $('#view-terminal').hidden) return;
    try { term.fit.fit(); } catch { return; }
    if (term.id && term.mode === 'pty') wapi(`/api/term/${term.id}/resize`, { method: 'POST', body: { cols: term.xt.cols, rows: term.xt.rows } }).catch(() => {});
  }

  function send(d) {
    if (!term.id) return;
    term.queue += d;
    if (!term.sending) flush();
  }
  async function flush() {
    term.sending = true;
    while (term.queue && term.id) {
      const data = term.queue; term.queue = '';
      try { await wapi(`/api/term/${term.id}/write`, { method: 'POST', body: { data } }); }
      catch (e) { term.xt.write(`\r\n\x1b[31m[${e.message}]\x1b[0m\r\n`); term.id = null; }
    }
    term.sending = false;
  }

  async function pump(id) {
    while (term.id === id) {
      term.abort = new AbortController();
      try {
        const r = await wapi(`/api/term/${id}/read?since=${term.seq}`, { signal: term.abort.signal });
        if (term.id !== id) return;
        if (r.data) term.xt.write(r.data);
        term.seq = r.seq;
        if (r.exited) { term.xt.write(`\r\n\x1b[2m[session ended${r.exitCode != null ? `, exit ${r.exitCode}` : ''}]\x1b[0m\r\n`); term.id = null; status('Session ended. Start a new one.'); return; }
      } catch (e) {
        if (e.name === 'AbortError' || term.id !== id) return;
        term.xt.write(`\r\n\x1b[31m[${e.message}]\x1b[0m\r\n`); term.id = null; status(e.message); return;
      }
    }
  }

  const status = (t) => { $('#term-status').textContent = t; };

  async function openTerminal({ fresh = false } = {}) {
    const xt = ensureXterm();
    if (!xt) { status('The terminal files did not load. Reload the page.'); return; }
    setTimeout(() => { fitNow(); xt.focus(); }, 30);
    if (term.id && !fresh) return;
    if (term.id) await closeTerminal();
    fitNow();
    xt.reset();
    try {
      const r = await wapi('/api/term/open', { method: 'POST', body: { cols: xt.cols, rows: xt.rows } });
      term.id = r.id; term.seq = 0; term.mode = r.mode;
      status(`${machine ? `${machineName()}: ` : ''}` + (r.mode === 'pipe' ? 'Connected (basic mode: no full-screen programs).' : 'Connected. Everything you run here is real.'));
      pump(r.id);
      xt.focus();
    } catch (e) { status(e.message); }
  }

  async function closeTerminal() {
    const id = term.id;
    term.id = null;
    term.abort?.abort();
    if (id) await wapi(`/api/term/${id}/close`, { method: 'POST' }).catch(() => {});
    status('Session ended.');
  }

  const KEYS = { esc: '\x1b', tab: '\t', ctrlc: '\x03', up: '\x1b[A', down: '\x1b[B' };
  function key(el) {
    const k = el.dataset.key;
    if (k === 'clear') { term.xt?.clear(); send('\x0c'); }
    else send(KEYS[k] || '');
    term.xt?.focus();
  }

  /* ───────── files ───────── */
  const fsx = { path: '.', file: null, mtime: 0, dirty: false };

  async function loadDir(p = fsx.path) {
    const box = $('#fs-list');
    try {
      const r = await wapi(`/api/fs/list?path=${encodeURIComponent(p)}`);
      fsx.path = r.path;
      const parts = r.path === '.' ? [] : r.path.split(/[\\/]/);
      $('#fs-crumbs').innerHTML = `<li><button data-action="ws-fs-go" data-path=".">${esc(r.root)}</button></li>`
        + parts.map((n, i) => `<li><button data-action="ws-fs-go" data-path="${esc(parts.slice(0, i + 1).join('/'))}">${esc(n)}</button></li>`).join('');
      const rel = (n) => (r.path === '.' ? n : `${r.path}/${n}`);
      box.innerHTML = r.entries.map((e) => `<button class="ws-entry${fsx.file === rel(e.name) ? ' is-open' : ''}" data-action="${e.dir ? 'ws-fs-go' : 'ws-fs-open'}" data-path="${esc(rel(e.name))}" title="${esc(e.mode)}">`
        + `<span aria-hidden="true">${e.dir ? '📁' : e.link ? '🔗' : '📄'}</span><span class="nm">${esc(e.name)}</span><span class="sz">${e.dir ? '' : esc(bytes(e.size))}</span></button>`).join('')
        || '<p class="muted">This folder is empty.</p>';
    } catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  }

  const leaveOk = () => !fsx.dirty || window.confirm('You have unsaved changes. Throw them away?');

  function gutter() {
    const n = $('#fs-text').value.split('\n').length;
    let s = '';
    for (let i = 1; i <= n; i++) s += `${i}\n`;
    $('#fs-gutter').textContent = s;
  }

  async function openFile(p) {
    if (!leaveOk()) return;
    try {
      const r = await wapi(`/api/fs/read?path=${encodeURIComponent(p)}`);
      fsx.file = r.path; fsx.mtime = r.mtime; fsx.dirty = false;
      $('#fs-file').textContent = r.path;
      $('#fs-text').value = r.content;
      $('#fs-state').textContent = bytes(r.size);
      $('#fs-editor-card').hidden = false;
      $('.ws-files').classList.remove('no-file');
      gutter();
      $('#fs-text').scrollTop = 0;
      loadDir();
      if (window.innerWidth < 900) $('#fs-editor-card').scrollIntoView({ block: 'start' });
    } catch (e) { say(e.message); }
  }

  async function saveFile() {
    if (!fsx.file) return;
    const btn = $('#fs-save');
    btn.disabled = true;
    try {
      const r = await wapi('/api/fs/write', { method: 'POST', body: { path: fsx.file, content: $('#fs-text').value, mtime: fsx.mtime } });
      fsx.mtime = r.mtime; fsx.dirty = false;
      $('#fs-state').textContent = `Saved · ${bytes(r.size)}`;
      loadDir();
    } catch (e) { $('#fs-state').textContent = e.message; }
    finally { btn.disabled = false; }
  }

  function closeFile() {
    if (!leaveOk()) return;
    fsx.file = null; fsx.dirty = false;
    $('#fs-editor-card').hidden = true;
    $('.ws-files').classList.add('no-file');
    loadDir();
  }

  /* ───────── wiring ───────── */
  async function switchMachine(id) {
    if (fsx.dirty && !window.confirm('You have unsaved changes. Throw them away?')) { $('#ws-machine').value = machine; return; }
    if (term.id) await closeTerminal();
    fsx.path = '.'; fsx.file = null; fsx.dirty = false;
    $('#fs-editor-card').hidden = true; $('.ws-files').classList.add('no-file'); $('#sv-logs-card').hidden = true;
    setMachine(id);
    renderPicker();
    await loadCaps();
    const view = ['server', 'terminal', 'files'].find((v) => !$(`#view-${v}`).hidden);
    if (view && document.querySelector(`.tab[data-view="${view}"]`)?.hidden) document.querySelector('.tab[data-view="server"]')?.click();
    else if (view) views[view]();
  }

  async function linkMachine(e) {
    e.preventDefault();
    const err = $('#machine-error');
    try {
      const r = await api('/api/machines', { method: 'POST', body: { name: $('#machine-name').value.trim(), url: $('#machine-url').value.trim(), code: $('#machine-code').value.trim() } });
      err.hidden = true;
      delete $('#dlg-machine').dataset.dirty;
      $('#dlg-machine').close();
      $('#machine-form').reset();
      machines.push(r.machine);
      say(`Linked ${r.machine.name}.`);
      await switchMachine(r.machine.id);
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  }

  async function unlinkMachine() {
    const m = machines.find((x) => x.id === machine);
    if (!m || !window.confirm(`Unlink ${m.name}? You can link it again with a new pairing code.`)) return;
    try {
      await api(`/api/machines/${encodeURIComponent(m.id)}`, { method: 'DELETE' });
      machines = machines.filter((x) => x.id !== m.id);
      say(`Unlinked ${m.name}. To sign this machine out there too, remove it from that machine's devices list.`);
      await switchMachine('');
    } catch (ex) { say(ex.message); }
  }

  const actions = {
    'ws-machine-add': () => { $('#machine-error').hidden = true; $('#dlg-machine').showModal(); $('#machine-name').focus(); },
    'ws-machine-remove': unlinkMachine,
    'ws-refresh-server': loadServer,
    'ws-proc': procAction,
    'ws-logs': showLogs,
    'ws-logs-close': () => { $('#sv-logs-card').hidden = true; },
    'ws-term-new': () => openTerminal({ fresh: true }),
    'ws-term-close': closeTerminal,
    'ws-key': key,
    'ws-fs-go': (el) => loadDir(el.dataset.path),
    'ws-fs-open': (el) => openFile(el.dataset.path),
    'ws-fs-up': () => { if (fsx.path !== '.') loadDir(fsx.path.split(/[\\/]/).slice(0, -1).join('/') || '.'); },
    'ws-fs-save': saveFile,
    'ws-fs-closefile': closeFile,
  };
  const views = {
    server: loadServer,
    terminal: () => (caps?.terminal ? openTerminal() : status('The terminal is not available on this machine.')),
    files: () => (caps?.files ? loadDir() : offNotice($('#fs-list'), 'file editor')),
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const a = el.dataset.action;
    if (actions[a]) { e.preventDefault(); actions[a](el); return; }
    if (a === 'view') {
      $('#ws-machine-bar').hidden = !views[el.dataset.view];
      if (el.dataset.view !== 'server') stopServer();
      // app.js has just shown the section; fill it once it is visible.
      setTimeout(() => views[el.dataset.view]?.(), 0);
    }
  });

  const ta = $('#fs-text');
  ta.addEventListener('input', () => { fsx.dirty = true; $('#fs-state').textContent = 'Unsaved changes'; gutter(); });
  ta.addEventListener('scroll', () => { $('#fs-gutter').scrollTop = ta.scrollTop; });
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); }
    else if (e.key === 'Tab' && !e.shiftKey && !e.altKey) {
      // Tab indents; Esc then Tab moves on, so the keyboard never gets stuck here.
      if (ta.dataset.escaped) { delete ta.dataset.escaped; return; }
      e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input'));
    } else if (e.key === 'Escape') ta.dataset.escaped = '1';
  });
  $('#ws-machine').addEventListener('change', (e) => switchMachine(e.target.value));
  $('#machine-form').addEventListener('submit', linkMachine);
  $('#sv-auto').addEventListener('change', (e) => { if (e.target.checked && !$('#view-server').hidden) loadServer(); else stopServer(); });
  window.addEventListener('beforeunload', (e) => { if (fsx.dirty) e.preventDefault(); });
  $('.ws-files').classList.add('no-file');
  document.querySelector('#dlg-connect')?.addEventListener('close', () => setTimeout(detect, 50));
  detect();
})();
