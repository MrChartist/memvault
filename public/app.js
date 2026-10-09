/* MemVault dashboard.
   Safety rules this file follows:
   - every piece of dynamic text goes through esc() — agents can write to the vault, so entry fields are untrusted
   - no inline handlers or styles (the page is served with a strict CSP); one delegated click handler below
   - the API token lives only in sessionStorage; it arrives in the URL fragment (never sent to a server) and is removed from the address bar at once */
(() => {
  'use strict';

  /* ───────── helpers ───────── */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const store = {
    get: (k, area = 'localStorage') => { try { return window[area].getItem(k); } catch { return null; } },
    set: (k, v, area = 'localStorage') => { try { window[area].setItem(k, v); } catch { /* storage blocked */ } },
    del: (k, area = 'localStorage') => { try { window[area].removeItem(k); } catch { /* storage blocked */ } },
  };
  const TOKEN_KEY = 'memvault-token';
  // The words on this page are English, so the page says so (a screen reader reads them with the right voice).
  // Notes written in other languages are marked on their own elements with dir="auto".

  // Text size: respects the browser's own setting, and lets anyone go larger. Remembered per browser.
  const SIZES = ['', 'm', 'l', 'xl'];
  function setTextSize(i) {
    const level = Math.max(0, Math.min(SIZES.length - 1, i));
    if (SIZES[level]) document.documentElement.dataset.text = SIZES[level]; else delete document.documentElement.dataset.text;
    store.set('memvault-text', String(level));
    return level;
  }
  let textLevel = setTextSize(Number(store.get('memvault-text')) || 0);

  /* ───────── messages ───────── */
  // Both bars use the browser's top layer when it has one, so they stay visible above an open dialog.
  const popOpen = (el) => { try { if (el.showPopover && !el.matches(':popover-open')) el.showPopover(); } catch { /* older browser: the fixed position still shows it */ } };
  const popClose = (el) => { try { if (el.hidePopover && el.matches(':popover-open')) el.hidePopover(); } catch { /* ignore */ } };
  let toastTimer;
  function toast(msg, isErr = false) {
    if (isErr) return toastErr(msg);
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show';
    popOpen(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; popClose(t); }, 6000);
  }
  // Problems stay on screen until the person closes them, so nobody misses one.
  function toastErr(msg) {
    $('#toast-err-text').textContent = msg;
    const t = $('#toast-err');
    t.className = 'show';
    popOpen(t);
  }
  function dismissErr() { const t = $('#toast-err'); t.className = ''; popClose(t); }

  const fmtTime = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(+d) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  const fmtDay = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(+d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const ago = (iso) => {
    const s = (Date.now() - +new Date(iso)) / 1000;
    if (!Number.isFinite(s)) return '';
    if (s < 90) return 'just now';
    if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
    if (s < 129600) return `${Math.round(s / 3600)} hours ago`;
    return `${Math.round(s / 86400)} days ago`;
  };

  /* ───────── token + api ───────── */
  (function captureToken() {
    const m = location.hash.match(/token=([^&]+)/);
    if (m) {
      store.set(TOKEN_KEY, decodeURIComponent(m[1]), 'sessionStorage');
      history.replaceState(null, '', location.pathname + location.search); // gone from the address bar
    }
  })();

  function setOnline(on) {
    $('#status-dot').className = `dot ${on ? 'on' : 'off'}`;
    $('#status-label').textContent = on ? 'Vault online' : 'Offline';
  }

  async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    const token = store.get(TOKEN_KEY, 'sessionStorage');
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      setOnline(false);
      throw new Error('MemVault is not running. Start it again, then reload this page.');
    }
    setOnline(true);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && res.headers.get('www-authenticate')) {
      store.del(TOKEN_KEY, 'sessionStorage');
      openConnect();
      throw new Error('Connect to your vault first.');
    }
    if (!res.ok) {
      const e = new Error(typeof data.error === 'string' ? data.error : 'That did not work. Please try again.');
      e.status = res.status;
      e.retryAfter = res.headers.get('retry-after');
      throw e;
    }
    return data;
  }

  const dlg = (id) => $(`#${id}`);
  function openConnect() {
    const d = dlg('dlg-connect');
    if (!d.open) d.showModal();
    $('#token-input').focus();
  }

  /* ───────── dialogs ───────── */
  // A dialog with typing in it asks before it throws that typing away.
  function markClean(d) { delete d.dataset.dirty; }
  function closeDialog(d) {
    if (d.dataset.dirty && !window.confirm('Close without saving what you typed?')) return false;
    markClean(d);
    d.close();
    return true;
  }
  $$('dialog[data-guard]').forEach((d) => {
    d.addEventListener('input', () => { if (d.open) d.dataset.dirty = '1'; });
    d.addEventListener('cancel', (e) => { if (d.dataset.dirty && !window.confirm('Close without saving what you typed?')) e.preventDefault(); else markClean(d); });
  });
  $$('dialog[data-keep]').forEach((d) => d.addEventListener('cancel', (e) => {
    // Without a working key the page has nothing to show, so this window stays until a key is entered.
    if (!store.get(TOKEN_KEY, 'sessionStorage')) e.preventDefault();
  }));

  function focusSoon(el) { if (el) setTimeout(() => el.focus({ preventScroll: false }), 30); }

  /* ───────── theme + tabs ───────── */
  function currentTheme() { const t = store.get('memvault-theme'); return t === 'light' || t === 'dark' ? t : 'auto'; }
  function applyTheme(mode) {
    if (mode === 'auto') { store.del('memvault-theme'); document.documentElement.setAttribute('data-theme', window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
    else { store.set('memvault-theme', mode); document.documentElement.setAttribute('data-theme', mode); }
  }
  function toggleTheme() {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    syncLookRadios();
  }

  const loaders = { memory: loadMemory, agents: () => { loadAgents(); loadPacks(); }, vault: loadVaultState, security: loadSecurity, settings: loadSettings };
  const HEADINGS = { memory: 'h-memory', agents: 'h-agents', vault: 'h-vault', security: 'h-security', settings: 'h-settings' };
  function showView(name, { focus = false } = {}) {
    $$('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
    $$('.tab').forEach((t) => {
      const on = t.dataset.view === name;
      t.classList.toggle('is-active', on);
      if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
    if (name !== 'vault') stopIdleLock();
    loaders[name]?.();
    // Moving to a new screen moves the cursor to its heading, so a screen reader announces where you are.
    if (focus) { const h = $(`#${name === 'vault' && !$('#unlocked').hidden ? 'h-secrets' : HEADINGS[name]}`); if (h) h.focus({ preventScroll: true }); window.scrollTo({ top: 0 }); }
  }

  /* ───────── memory ───────── */
  const mem = { type: '', viewAs: '', q: '', select: false, selected: new Set(), rows: [], current: null };
  const TYPE_LABEL = { diary: 'Note', conversation: 'Conversation', worklog: 'Work log', file: 'File' };
  const isPinned = (e) => String(e.tags || '').split(',').map((t) => t.trim()).includes('pinned');
  const titleOf = (e) => e.title || 'Untitled';
  const REDACT_WORDS = {
    'secret-assignment': 'password or key', 'github-token': 'access key', 'anthropic-key': 'access key', 'openai-key': 'access key', 'aws-access-key': 'access key',
    'google-api-key': 'access key', 'slack-token': 'access key', 'stripe-key': 'access key', 'vendor-token': 'access key', jwt: 'login token', 'bearer-token': 'login token',
    authorization: 'login token', 'url-credentials': 'password', 'card-number': 'card number', aadhaar: 'ID number', pan: 'ID number', 'us-ssn': 'ID number',
    'uk-nino': 'ID number', 'ca-sin': 'ID number', iban: 'bank number', 'account-number': 'bank number', 'passport-number': 'passport number', 'one-time-code': 'one-time code',
    'private-key': 'private key', 'webhook-url': 'secret link', 'cloud-key': 'access key', 'short-password': 'password', 'command-line-password': 'password',
  };
  const hidWords = (list) => (list || []).map((x) => `${x.count} ${REDACT_WORDS[x.type] || 'private detail'}${x.count === 1 ? '' : 's'}`).join(', ');

  async function loadMemory() {
    try {
      const [stats, agents] = await Promise.all([api('/stats'), api('/agents')]);
      renderStats(stats);
      fillViewAs(agents.agents);
      $('#guide').hidden = store.get('memvault-guide') === 'hidden';
      await loadEntries();
    } catch (e) {
      $('#entries').innerHTML = `<div class="empty">${esc(e.message)}${/not running/.test(e.message) ? '' : ''}</div>`;
      $('#results-status').textContent = '';
    }
  }

  function renderStats(s) {
    const cells = [
      ['Total memories', s.total, true],
      ['Notes', s.byType.diary || 0],
      ['Conversations', s.byType.conversation || 0],
      ['Work logs', s.byType.worklog || 0],
      ['Agents', s.agents],
      ['Private to one agent', s.privateItems],
    ];
    $('#stats').innerHTML = cells
      .map(([label, n, hero]) => `<div class="stat${hero ? ' hero' : ''}"><b>${esc(n)}</b><span>${esc(label)}</span></div>`)
      .join('');
  }

  function fillViewAs(agents) {
    const sel = $('#viewas');
    const keep = mem.viewAs;
    sel.innerHTML = '<option value="">Everything (you)</option>' +
      agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
    sel.value = agents.some((a) => a.id === keep) ? keep : '';
    mem.viewAs = sel.value;
  }

  async function loadEntries() {
    const box = $('#entries');
    box.setAttribute('aria-busy', 'true');
    if (!mem.rows.length) box.innerHTML = '<div class="empty">Loading…</div>';
    const p = new URLSearchParams();
    if (mem.type) p.set('type', mem.type);
    if (mem.viewAs) p.set('agent', mem.viewAs);
    let path;
    if (mem.q) { p.set('q', mem.q); path = `/search?${p}`; } else { p.set('limit', '100'); path = `/list?${p}`; }
    try {
      const { results } = await api(path);
      mem.rows = results;
      mem.selected = new Set([...mem.selected].filter((id) => results.some((r) => r.id === id)));
      renderEntries(results);
    } finally {
      box.removeAttribute('aria-busy');
    }
  }

  function emptyMessage() {
    if (mem.q) return `Nothing found for “${esc(mem.q)}”. Try fewer or different words.`;
    if (mem.type || mem.viewAs) return 'Nothing here for this choice. Choose “All” above to see everything.';
    return 'No memories yet. Write a note above, or connect an AI app and ask it to remember something.';
  }

  function renderEntries(rows) {
    const box = $('#entries');
    $('#results-status').textContent = rows.length === 1 ? '1 memory shown' : `${rows.length} memories shown`;
    if (!rows.length) {
      box.innerHTML = `<div class="empty">${emptyMessage()}</div>`;
      updateSelection();
      return;
    }
    box.innerHTML = rows.map((e) => {
      const priv = e.scope && e.scope !== 'shared';
      const pinned = isPinned(e);
      const t = esc(titleOf(e));
      const picked = mem.selected.has(e.id);
      return `<article class="entry${picked ? ' is-picked' : ''}${pinned ? ' is-pinned' : ''}" data-id="${esc(e.id)}">
        <div class="entry-head">
          ${mem.select ? `<label class="pick"><input type="checkbox" data-action="pick" data-id="${esc(e.id)}"${picked ? ' checked' : ''}> <span class="sr-only">Select: ${t}</span></label>` : ''}
          ${pinned ? '<span class="badge pinned">Pinned</span>' : ''}
          <span class="badge t-${esc(e.type)}">${esc(TYPE_LABEL[e.type] || e.type)}</span>
          ${e.agent_id ? `<span class="badge by-agent">${esc(e.agent_id)}</span>` : ''}
          ${priv ? `<span class="badge priv">${esc(e.scope.startsWith('agent:') ? 'private' : e.scope)}</span>` : ''}
          ${e.source ? `<span>${esc(e.source)}</span>` : ''}
          <time datetime="${esc(e.created_at)}">${esc(fmtTime(e.created_at))}</time>
        </div>
        <h3 dir="auto"><button type="button" class="linklike" data-action="open-item" data-id="${esc(e.id)}">${t}</button></h3>
        ${e.snippet ? `<p dir="auto">${esc(e.snippet)}</p>` : ''}
        <div class="entry-actions">
          <button type="button" class="btn sm ghost" data-action="pin-item" data-id="${esc(e.id)}" aria-pressed="${pinned}" aria-label="${pinned ? 'Unpin' : 'Pin'}: ${t}">${pinned ? 'Unpin' : 'Pin'}</button>
          <button type="button" class="btn sm ghost" data-action="edit-item" data-id="${esc(e.id)}" aria-label="Edit: ${t}">Edit</button>
          <button type="button" class="btn sm ghost" data-action="delete-item" data-id="${esc(e.id)}" aria-label="Delete: ${t}">Delete</button>
        </div>
      </article>`;
    }).join('');
    updateSelection();
  }

  async function saveDiary(ev) {
    ev.preventDefault();
    const input = $('#diary-input');
    const text = input.value.trim();
    if (!text) return toast('Write a note first.', true);
    if (text.length > 200000) return toast('That note is very long. Please split it into two or more notes.', true);
    const btn = $('#save-btn');
    btn.disabled = true;
    try {
      const now = new Date();
      const r = await api('/add', {
        method: 'POST',
        body: {
          type: 'diary', source: 'manual', tags: 'diary,manual', content: text,
          title: `Note · ${now.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} ${now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`,
        },
      });
      input.value = '';
      $('#char-count').textContent = '0 characters';
      const hid = r.redacted?.length ? ` (hid ${hidWords(r.redacted)})` : '';
      toast(`Note saved${hid}`);
      mem.q = ''; $('#search-input').value = '';
      await loadMemory();
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  /* — one memory: open, edit, pin, delete, undo, download — */
  async function fetchItem(id) { return (await api(`/items/${encodeURIComponent(id)}`)).item; }

  function showMemoryDialog(item, { edit = false } = {}) {
    mem.current = item;
    const d = dlg('dlg-memory');
    markClean(d);
    $('#mem-title').textContent = titleOf(item);
    $('#mem-meta').textContent = `${TYPE_LABEL[item.type] || item.type} · ${fmtDay(item.created_at)}${item.agent_id ? ` · written by ${item.agent_id}` : ''}${item.scope && item.scope !== 'shared' ? ' · private' : ''}${isPinned(item) ? ' · pinned' : ''}`;
    $('#mem-full').textContent = item.content || '(No text)';
    $('#mem-pin').textContent = isPinned(item) ? 'Unpin' : 'Pin';
    $('#mem-view-step').hidden = edit;
    $('#mem-edit-step').hidden = !edit;
    $('#mem-error').hidden = true;
    if (edit) {
      $('#m-title').value = item.title || '';
      $('#m-content').value = item.content || '';
      $('#m-tags').value = item.tags || '';
    }
    if (!d.open) d.showModal();
    focusSoon(edit ? $('#m-title') : $('#mem-full'));
  }

  async function openItem(id, edit = false) {
    try { showMemoryDialog(await fetchItem(id), { edit }); } catch (e) { toast(e.message, true); loadEntries().catch(() => {}); }
  }

  async function saveMemory() {
    const err = $('#mem-error');
    const fail = (m) => { err.textContent = m; err.hidden = false; err.focus(); };
    const it = mem.current;
    if (!it) return;
    const title = $('#m-title').value.trim();
    const content = $('#m-content').value;
    if (!title && !content.trim()) return fail('A memory needs a title or some text.');
    try {
      const r = await api(`/items/${encodeURIComponent(it.id)}`, { method: 'PATCH', body: { title, content, tags: $('#m-tags').value.trim() } });
      markClean(dlg('dlg-memory'));
      dlg('dlg-memory').close();
      toast(`Saved${r.redacted?.length ? ` (hid ${hidWords(r.redacted)})` : ''}`);
      await loadMemory();
    } catch (e) { fail(`${e.message} What you typed is still here.`); }
  }

  async function togglePin(id, pinnedNow) {
    try {
      await api(`/items/${encodeURIComponent(id)}`, { method: 'PATCH', body: { pinned: !pinnedNow } });
      toast(pinnedNow ? 'Unpinned' : 'Pinned. It will stay at the top.');
      await loadEntries();
      focusSoon($(`[data-action="pin-item"][data-id="${CSS.escape(id)}"]`));
    } catch (e) { toast(e.message, true); }
  }

  /* undo bar: shown after a delete, for a while; paused while the pointer or keyboard is on it */
  let undoState = null;
  let undoTimer;
  function showUndo(message, restoreFn) {
    undoState = restoreFn;
    $('#undo-text').textContent = message;
    $('#undo').hidden = false;
    armUndo();
  }
  function armUndo() { clearTimeout(undoTimer); undoTimer = setTimeout(hideUndo, 12000); }
  function hideUndo() { clearTimeout(undoTimer); $('#undo').hidden = true; undoState = null; }
  $('#undo').addEventListener('mouseenter', () => clearTimeout(undoTimer));
  $('#undo').addEventListener('focusin', () => clearTimeout(undoTimer));
  $('#undo').addEventListener('mouseleave', armUndo);
  $('#undo').addEventListener('focusout', armUndo);

  async function deleteItem(id) {
    let item = mem.rows.find((r) => r.id === id) || (mem.current?.id === id ? mem.current : null);
    try {
      await api(`/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (dlg('dlg-memory').open) { markClean(dlg('dlg-memory')); dlg('dlg-memory').close(); }
      showUndo(`Deleted “${titleOf(item || {})}”.`, async () => { await api(`/items/${encodeURIComponent(id)}/restore`, { method: 'POST' }); });
      await loadMemory();
      focusSoon($('#entries .linklike') || $('#diary-input'));
    } catch (e) { toast(e.message, true); }
  }

  async function doUndo() {
    const fn = undoState;
    if (!fn) return;
    hideUndo();
    try { await fn(); toast('Put back.'); await loadMemory(); if (!$('#view-settings').hidden) loadTrash(); } catch (e) { toast(e.message, true); }
  }

  function download(name, text, type = 'application/json') {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const fileSafe = (s) => String(s).normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'memory';

  /* — choosing several — */
  function updateSelection() {
    $('#selbar').hidden = !mem.select;
    const n = mem.selected.size;
    $('#sel-count').textContent = n === 1 ? '1 selected' : `${n} selected`;
    $('#delete-selected').disabled = n === 0;
    const t = $('#select-toggle');
    t.setAttribute('aria-pressed', String(mem.select));
    t.textContent = mem.select ? 'Stop selecting' : 'Select several';
  }
  function toggleSelectMode() {
    mem.select = !mem.select;
    mem.selected.clear();
    renderEntries(mem.rows);
    focusSoon($('#select-toggle'));
  }
  function openBulk() {
    const n = mem.selected.size;
    if (!n) return;
    $('#bulk-title').textContent = `Delete ${n} ${n === 1 ? 'memory' : 'memories'}?`;
    $('#bulk-text').textContent = 'A backup of your vault is made first. You can put these back for one hour using Undo, or from Settings → Recently deleted.';
    $('#bulk-label').textContent = `Type DELETE ${n} to confirm`;
    $('#bulk-confirm').value = '';
    $('#bulk-go').disabled = true;
    dlg('dlg-bulk').showModal();
    focusSoon($('#bulk-confirm'));
  }
  async function bulkGo() {
    const ids = [...mem.selected];
    try {
      const r = await api('/items/delete-many', { method: 'POST', body: { ids, confirm: `DELETE ${ids.length}` } });
      dlg('dlg-bulk').close();
      mem.selected.clear(); mem.select = false;
      showUndo(`Deleted ${r.deleted} ${r.deleted === 1 ? 'memory' : 'memories'}.`, async () => { await api('/items/restore-many', { method: 'POST', body: { ids } }); });
      await loadMemory();
      focusSoon($('#select-toggle'));
    } catch (e) { dlg('dlg-bulk').close(); toast(e.message, true); }
  }

  /* ───────── agents ───────── */
  let agentCache = [];
  let deletingId = null;

  async function loadAgents() {
    const box = $('#agents');
    try {
      const { agents } = await api('/agents');
      agentCache = agents;
      if (!agents.length) {
        box.innerHTML = '<div class="empty card">No agents yet. Add the starter agents, or describe one of your own.</div>';
        return;
      }
      const full = await Promise.all(agents.map((a) => api(`/agents/${encodeURIComponent(a.id)}`).then((r) => r.agent).catch(() => null)));
      box.innerHTML = full.filter(Boolean).map((p) => {
        const wide = p.memory.allowSecrets || p.memory.readScopes.some((s) => s.startsWith('agent:'));
        const n = agents.find((a) => a.id === p.id)?.memories ?? 0;
        const nm = esc(p.name);
        return `<article class="card agent">
          <div><h3 dir="auto">${nm}</h3><span class="id">${esc(p.id)}</span></div>
          <p class="role" dir="auto">${esc(p.role) || '<span class="muted">No job described yet</span>'}</p>
          <div class="meta">
            <span class="badge">${esc(n)} ${n === 1 ? 'memory' : 'memories'}</span>
            <span class="badge">${esc(p.rules.always.length)} must-do ${p.rules.always.length === 1 ? 'rule' : 'rules'}</span>
            <span class="badge">${esc(p.rules.never.length)} must-not-do ${p.rules.never.length === 1 ? 'rule' : 'rules'}</span>
            ${p.brand.handle || p.brand.site ? `<span class="badge brand">${esc(p.brand.handle || p.brand.site)}</span>` : ''}
            ${wide ? '<span class="badge warnflag" title="This agent can see more than usual">Can see more than usual</span>' : ''}
          </div>
          <div class="actions">
            <button class="btn sm primary" data-action="copy-brief" data-id="${esc(p.id)}" aria-label="Copy instructions for ${nm}">Copy instructions</button>
            <button class="btn sm" data-action="copy-mcp" data-id="${esc(p.id)}" aria-label="Copy connection settings for ${nm}">Copy connection settings</button>
            <button class="btn sm" data-action="edit-agent" data-id="${esc(p.id)}" aria-label="Edit ${nm}">Edit</button>
            <button class="btn sm ghost" data-action="delete-agent" data-id="${esc(p.id)}" aria-label="Delete ${nm}">Delete</button>
          </div>
        </article>`;
      }).join('');
    } catch (e) {
      box.innerHTML = `<div class="empty card">${esc(e.message)}</div>`;
    }
  }

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg);
    } catch {
      // Clipboard blocked: show the text so it can be copied by hand.
      $('#text-title').textContent = 'Copy this text';
      $('#text-body').value = text;
      dlg('dlg-text').showModal();
    }
  }

  /* The form edits a profile. Fields the form does not show (and the JSON box, if used) are preserved. */
  let currentProfile = null;
  let agentIsNew = true;
  let jsonDirty = false;
  const lines = (t) => t.split('\n').map((x) => x.trim()).filter(Boolean);
  const csv = (t) => t.split(',').map((x) => x.trim()).filter(Boolean);
  const slugify = (n) => (String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent').replace(/^([^a-z])/, 'a$1');

  function fillAgentForm(p, isNew) {
    currentProfile = p; agentIsNew = isNew; jsonDirty = false;
    $('#f-name').value = p.name; $('#f-id').value = p.id; $('#f-id').readOnly = !isNew;
    $('#f-role').value = p.role; $('#f-lang').value = p.voice.language; $('#f-tone').value = p.voice.tone;
    $('#f-always').value = p.rules.always.join('\n'); $('#f-never').value = p.rules.never.join('\n'); $('#f-persona').value = p.persona;
    $('#f-handle').value = p.brand.handle; $('#f-site').value = p.brand.site;
    $('#f-style').value = p.outputStyle.join('\n'); $('#f-domains').value = p.domains.join(', ');
    $('#f-read').value = p.memory.readScopes.join(', '); $('#f-secrets').checked = p.memory.allowSecrets;
    $('#agent-json').value = JSON.stringify(p, null, 2);
    $('#agent-more').open = false;
  }

  function readAgentForm() {
    if (jsonDirty) return JSON.parse($('#agent-json').value); // the advanced box wins when it was edited
    const name = $('#f-name').value.trim();
    return {
      ...currentProfile,
      id: $('#f-id').value.trim() || slugify(name),
      name, role: $('#f-role').value.trim(), persona: $('#f-persona').value.trim(),
      voice: { language: $('#f-lang').value.trim(), tone: $('#f-tone').value.trim() },
      rules: { always: lines($('#f-always').value), never: lines($('#f-never').value) },
      outputStyle: lines($('#f-style').value), domains: csv($('#f-domains').value),
      brand: { ...currentProfile.brand, handle: $('#f-handle').value.trim(), site: $('#f-site').value.trim() },
      memory: { ...currentProfile.memory, readScopes: csv($('#f-read').value), allowSecrets: $('#f-secrets').checked },
    };
  }

  function showAgentDialog({ title, step, profile, isNew, notes = [] }) {
    $('#agent-title').textContent = title;
    $('#agent-draft-step').hidden = step !== 'draft';
    $('#agent-edit-step').hidden = step !== 'edit';
    $('#agent-error').hidden = true;
    if (profile) fillAgentForm(profile, isNew);
    $('#agent-notes').innerHTML = notes.map((n) => `<li>${esc(n)}</li>`).join('');
    const d = dlg('dlg-agent');
    if (!d.open) { markClean(d); d.showModal(); }
  }

  async function draftAgent() {
    const prompt = $('#agent-prompt').value.trim();
    if (!prompt) return toast('Describe the helper first.', true);
    try {
      const r = await api('/agents/draft', { method: 'POST', body: { prompt, name: $('#agent-name').value.trim() || undefined } });
      showAgentDialog({ title: 'Check the draft', step: 'edit', profile: r.profile, isNew: true, notes: r.notes });
    } catch (e) { toast(e.message, true); }
  }

  async function saveAgent() {
    const err = $('#agent-error');
    const fail = (m) => { err.textContent = m; err.hidden = false; err.focus(); };
    let profile;
    try { profile = readAgentForm(); } catch (e) { return fail(`The text in the advanced box is not valid: ${e.message}`); }
    if (agentIsNew && agentCache.some((a) => a.id === profile.id)) {
      return fail(`A helper with the short name "${profile.id}" already exists. Choose a different short name so it is not replaced.`);
    }
    try {
      const r = await api(`/agents/${encodeURIComponent(profile.id)}`, { method: 'PUT', body: profile });
      markClean(dlg('dlg-agent'));
      dlg('dlg-agent').close();
      toast(`Saved ${r.agent.name}`);
      await loadAgents();
    } catch (e) { fail(e.message); }
  }

  /* ───────── starter packs ───────── */
  let packs = [];
  async function loadPacks() {
    try {
      packs = (await api('/agents/packs')).packs;
      $('#pack-select').innerHTML = packs.map((p) => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('') + '<option value="all">Every set</option>';
      showPackDesc();
    } catch { /* the list still works without packs */ }
  }
  function showPackDesc() {
    const id = $('#pack-select').value;
    const p = packs.find((x) => x.id === id);
    $('#pack-desc').textContent = id === 'all' ? 'Adds every starter set.' : p ? `${p.description} Adds: ${p.agents.map((a) => a.name).join(', ')}.` : '';
  }

  /* ───────── connect an AI app ───────── */
  const OS = /Win/i.test(navigator.platform || navigator.userAgent) ? 'win' : /Mac/i.test(navigator.platform || navigator.userAgent) ? 'mac' : 'linux';
  const APPS = [
    { id: 'claude-desktop', name: 'Claude Desktop', file: { win: '%APPDATA%\\Claude\\claude_desktop_config.json', mac: '~/Library/Application Support/Claude/claude_desktop_config.json', linux: '~/.config/Claude/claude_desktop_config.json' }, how: 'Open that file (in Claude Desktop it is usually under Settings → Developer → Edit Config). Add the block below inside "mcpServers", save, then quit Claude completely and open it again.' },
    { id: 'cursor', name: 'Cursor', file: '~/.cursor/mcp.json', how: 'Create or open that file and add the block below inside "mcpServers". You can also use Cursor Settings → MCP.' },
    { id: 'claude-code', name: 'Claude Code (terminal)', command: true, how: 'Paste this command into your terminal and press Enter.' },
    { id: 'antigravity', name: 'Antigravity', file: '~/.gemini/antigravity/mcp_config.json', how: 'Open that file and add the block below inside "mcpServers", then restart Antigravity.' },
    { id: 'vscode', name: 'VS Code (Cline / Roo)', file: "the extension's MCP settings file", how: 'Open the extension, choose its MCP Servers screen, and edit the settings file it shows. Add the block below inside "mcpServers".' },
    { id: 'other', name: 'Another app', command: false, how: 'Any app that can connect to tools lets you add one by giving it a command and arguments. Use the values in this block.' },
  ];
  let appsCfg = null;
  const q = (x) => (/[\s"]/.test(x) ? `"${String(x).replace(/"/g, '\\"')}"` : String(x));

  async function openApps() {
    try { appsCfg = (await api('/mcp-config')).config; } catch (e) { return toast(e.message, true); }
    $('#apps-list').innerHTML = APPS.map((a) => `<button type="button" class="chip" aria-pressed="false" data-action="pick-app" data-app="${esc(a.id)}">${esc(a.name)}</button>`).join('');
    pickApp(APPS[0].id);
    dlg('dlg-apps').showModal();
  }
  function pickApp(id) {
    const app = APPS.find((a) => a.id === id);
    $$('#apps-list .chip').forEach((c) => { const on = c.dataset.app === id; c.classList.toggle('is-active', on); c.setAttribute('aria-pressed', String(on)); });
    const entry = appsCfg.mcpServers.memvault;
    const json = JSON.stringify(appsCfg, null, 2);
    let block = `<p>${esc(app.how)}</p>`;
    const where = app.file && (typeof app.file === 'string' ? app.file : app.file[OS]);
    if (where) block += `<p class="label">Where</p><div class="code" tabindex="0" role="region" aria-label="File location">${esc(where)}</div>`;
    if (app.command) {
      const env = Object.entries(entry.env || {}).map(([k, v]) => `--env ${k}=${q(v)}`).join(' ');
      // --env takes several values, so something must sit between it and the name: the name would be read as one more value.
      const cmd = `claude mcp add ${env} --transport stdio memvault -- ${q(entry.command)} ${entry.args.map(q).join(' ')}`.replace(/\s+/g, ' ');
      block += `<div class="code" tabindex="0" role="region" aria-label="Command to run">${esc(cmd)}</div><button type="button" class="btn primary" data-action="copy-value" data-value="${esc(cmd)}">Copy the command</button>`;
    } else {
      block += `<p class="label">Paste this</p><div class="code" tabindex="0" role="region" aria-label="Settings to paste">${esc(json)}</div><button type="button" class="btn primary" data-action="copy-value" data-value="${esc(json)}">Copy</button>`;
    }
    block += '<p class="hint">To give an app its own helper, with its own limited view of your memory, use Agents → Copy connection settings instead.</p>';
    $('#apps-body').innerHTML = block;
  }

  /* ───────── secure vault ───────── */
  let vaultPw = null;
  let vaultNew = false;
  let idleTimer;
  const IDLE_MS = 5 * 60 * 1000;
  const CAT = {
    apikey: ['API keys', [['key', 'API key'], ['env', 'Environment'], ['notes', 'Notes']]],
    password: ['Passwords', [['username', 'Username / email'], ['password', 'Password'], ['url', 'Website'], ['notes', 'Notes']]],
    userid: ['User IDs', [['userid', 'User ID'], ['service', 'Service'], ['notes', 'Notes']]],
    payment: ['Payment details', [['label', 'Card label'], ['last4', 'Last 4 digits'], ['expiry', 'Expiry (MM/YY)'], ['notes', 'Notes']]],
    phone: ['Phone numbers', [['name', 'Name'], ['number', 'Number'], ['notes', 'Notes']]],
    custom: ['Custom', [['value', 'Value'], ['notes', 'Notes']]],
  };

  function armIdleLock() {
    clearTimeout(idleTimer);
    if (vaultPw) idleTimer = setTimeout(() => { lock(); toast('The Secure Vault was locked after 5 minutes without use.'); }, IDLE_MS);
  }
  function stopIdleLock() { clearTimeout(idleTimer); }
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { if (vaultPw) armIdleLock(); }, true));

  async function loadVaultState() {
    if (vaultPw) return;
    try {
      const { initialised } = await api('/secrets/status');
      vaultNew = !initialised;
    } catch { vaultNew = false; }
    $('#setup-extra').hidden = !vaultNew;
    $('#unlock-btn').textContent = vaultNew ? 'Create the Secure Vault' : 'Unlock';
    $('#pw-help').textContent = vaultNew
      ? 'Choose a master password of at least 10 characters. MemVault cannot recover it. If you forget it, what you lock in here is gone for good. Write it down somewhere safe.'
      : '';
  }

  async function unlock(ev) {
    ev.preventDefault();
    const pw = $('#master-pw').value;
    const err = $('#pw-error');
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    if (!pw) return fail('Type your master password.');
    if (vaultNew) {
      if (pw.length < 10) return fail('Use at least 10 characters.');
      if (pw !== $('#master-pw2').value) return fail('The two passwords are not the same. Type the second one again.');
    }
    try {
      await api('/secrets/verify', { method: 'POST', body: { password: pw } });
      vaultPw = pw;
      vaultNew = false;
      err.hidden = true;
      $('#master-pw').value = ''; $('#master-pw2').value = '';
      $('#lock').hidden = true;
      $('#unlocked').hidden = false;
      armIdleLock();
      await loadSecrets();
      focusSoon($('#h-secrets'));
    } catch (e) {
      fail(e.status === 429 ? e.message : e.status === 401 ? 'That is not the right password. Try again.' : e.message);
    }
  }

  function lock() {
    vaultPw = null;
    stopIdleLock();
    $('#unlocked').hidden = true;
    $('#lock').hidden = false;
    $('#secrets').innerHTML = '';
    const d = dlg('dlg-reveal'); if (d.open) d.close();
    loadVaultState();
    focusSoon($('#master-pw'));
  }

  async function loadSecrets() {
    const { secrets } = await api('/secrets/list');
    const box = $('#secrets');
    if (!secrets.length) { box.innerHTML = '<div class="empty">Nothing locked in here yet. Choose “Add a secret”.</div>'; return; }
    const groups = {};
    for (const s of secrets) (groups[s.category] ||= []).push(s);
    box.innerHTML = Object.entries(groups).map(([cat, items]) => `
      <div class="cat"><div class="label">${esc(CAT[cat]?.[0] || cat)}</div>
        ${items.map((s) => `<div class="secret-row">
          <button type="button" class="secret" data-action="reveal" data-id="${esc(s.id)}">
            <span class="grow"><b>${esc(s.label)}</b><small>Updated ${esc(fmtDay(s.updated_at))}</small></span>
          </button>
          <button type="button" class="btn sm ghost" data-action="delete-secret" data-id="${esc(s.id)}" aria-label="Delete secret: ${esc(s.label)}">Delete</button>
        </div>`).join('')}
      </div>`).join('');
  }

  let revealTimer;
  async function reveal(id) {
    try {
      const d = await api('/secrets/get', { method: 'POST', body: { id, password: vaultPw } });
      $('#reveal-title').textContent = d.label;
      $('#reveal-fields').innerHTML = Object.entries(d.fields).map(([k, v], i) =>
        `<div class="reveal"><div class="k" id="rk-${i}">${esc(k)}</div>
          <div class="row gap wrap"><span class="v" id="rv-${i}" data-real="${esc(v)}" aria-labelledby="rk-${i}">••••••••</span>
          <button type="button" class="btn sm" data-action="show-value" data-i="${i}" data-name="${esc(k)}" aria-label="Show ${esc(k)}">Show</button>
          <button type="button" class="btn sm" data-action="copy-value" data-value="${esc(v)}" aria-label="Copy ${esc(k)}">Copy</button></div></div>`).join('');
      dlg('dlg-reveal').showModal();
      clearTimeout(revealTimer);
      revealTimer = setTimeout(() => { const r = dlg('dlg-reveal'); if (r.open) r.close(); }, 60000);
    } catch (e) { toast(e.status === 429 ? e.message : 'Could not open that item. Check your master password.', true); }
  }

  function openAddSecret() {
    const sel = $('#s-category');
    sel.innerHTML = Object.entries(CAT).map(([k, [name]]) => `<option value="${esc(k)}">${esc(name)}</option>`).join('');
    renderSecretFields();
    $('#s-label').value = '';
    markClean(dlg('dlg-secret'));
    dlg('dlg-secret').showModal();
  }
  function renderSecretFields() {
    const fields = CAT[$('#s-category').value]?.[1] || CAT.custom[1];
    $('#s-fields').innerHTML = fields.map(([k, label]) =>
      `<label class="label" for="sf-${esc(k)}">${esc(label)}</label><input id="sf-${esc(k)}" data-field="${esc(k)}" type="${k === 'password' ? 'password' : 'text'}" autocomplete="off" />`).join('');
  }
  async function saveSecret(ev) {
    ev.preventDefault();
    const category = $('#s-category').value;
    const label = $('#s-label').value.trim();
    if (!label) return toast('Give it a name.', true);
    const fields = {};
    $$('#s-fields input').forEach((i) => { if (i.value.trim()) fields[i.dataset.field] = i.value.trim(); });
    if (!Object.keys(fields).length) return toast('Fill in at least one box.', true);
    try {
      await api('/secrets/add', { method: 'POST', body: { password: vaultPw, category, label, fields } });
      markClean(dlg('dlg-secret'));
      dlg('dlg-secret').close();
      toast('Locked and saved');
      await loadSecrets();
    } catch (e) { toast(e.message, true); }
  }

  /* ───────── security ───────── */
  const ICON = { ok: ['✓', 'OK'], warn: ['!', 'Warning'], bad: ['✕', 'Problem'], info: ['i', 'Note'] };

  async function loadSecurity() {
    try {
      const [status, audit, backups] = await Promise.all([api('/status?deep=1'), api('/audit?limit=15'), api('/backups')]);
      const ico = (lvl) => `<span class="ico ${esc(lvl)}" aria-hidden="true">${ICON[lvl]?.[0] || ''}</span><span class="sr-only">${esc(ICON[lvl]?.[1] || '')}: </span>`;
      $('#posture').innerHTML = status.rows.map((r) =>
        `<div class="check-row">${ico(r.level)}<div><div>${esc(r.title)}</div>${r.fix ? `<div class="fix">${esc(r.fix)}</div>` : ''}</div></div>`).join('') +
        `<div class="check-row">${ico(status.counts.bad ? 'bad' : status.counts.warn ? 'warn' : 'ok')}<div><b>${status.counts.bad ? `${status.counts.bad} ${status.counts.bad === 1 ? 'problem' : 'problems'}` : 'No problems'}${status.counts.warn ? `, ${status.counts.warn} ${status.counts.warn === 1 ? 'warning' : 'warnings'}` : ''}</b></div></div>`;

      const pill = $('#chain-pill');
      pill.className = `pill ${audit.chain.ok ? 'good' : 'bad'}`;
      pill.textContent = audit.chain.ok ? `Log intact · ${audit.chain.entries} records` : 'The activity list was changed by something else';
      $('#audit').innerHTML = audit.recent.length
        ? `<table><caption class="sr-only">Recent activity</caption><thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">Details</th></tr></thead><tbody>${audit.recent.slice().reverse().map((r) => {
            const d = r.detail || {};
            const what = d.tool ? `${r.action}: ${d.tool}` : r.action;
            const more = Object.entries(d).filter(([k]) => k !== 'tool').map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`).join(' ');
            return `<tr><td class="time">${esc(fmtTime(r.ts))}</td><td>${esc(r.actor)}</td><td>${esc(what)}</td><td class="muted">${esc(more)}</td></tr>`;
          }).join('')}</tbody></table>`
        : '<div class="empty">Nothing has been recorded yet.</div>';

      $('#backups').innerHTML = backups.backups.length
        ? backups.backups.slice(0, 6).map((b) => `<div class="check-row"><span class="ico ok" aria-hidden="true">✓</span><div>${esc(b.name)} <span class="muted small">· ${esc((b.size / 1024).toFixed(0))} KB · ${esc(fmtTime(b.modified))}</span></div></div>`).join('')
        : '<div class="empty">No backups yet. Choose “Back up now”.</div>';
    } catch (e) {
      $('#posture').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  async function backupNow(btn) {
    btn.disabled = true;
    try {
      const { results } = await api('/backup', { method: 'POST' });
      const bad = results.some((r) => !r.ok);
      toast(results.map((r) => `${r.backend === 'local' ? 'On this computer' : r.backend === 'gdriveFolder' ? 'Google Drive folder' : 'Google Drive'}: ${r.ok ? (r.encrypted ? 'done, locked with your passphrase' : 'done') : r.error}`).join(' · '), bad);
      if (!$('#view-security').hidden) await loadSecurity();
      if (!$('#view-settings').hidden) await loadBackupInfo();
    } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
  }

  /* ───────── settings ───────── */
  const CAPTURE_INFO = {
    git: ['Code commits', 'Saves the title and date of recent git commits it finds in your home folder.'],
    vscode: ['VS Code', 'Saves the names of your recent VS Code projects and add-ons.'],
    files: ['Changed files', 'Saves the names (never the contents) of files you changed recently.'],
    system: ['This computer', 'Saves basic facts about this computer, such as the system type and which developer tools are installed.'],
    browser: ['Browser pages', 'Saves page titles and web addresses (without anything after a ? mark) from Chrome, Edge, Brave and Chromium. Pages on this computer or your home network are skipped.'],
    clipboard: ['What you copy', 'Saves text you copy, while the clipboard watcher is running (start it with “memvault clipboard”). Passwords and card numbers are hidden first.'],
  };
  let settings = null;

  function syncLookRadios() {
    $$('input[name="textsize"]').forEach((r) => { r.checked = Number(r.value) === textLevel; });
    const th = currentTheme();
    $$('input[name="theme"]').forEach((r) => { r.checked = r.value === th; });
  }

  async function loadSettings() {
    syncLookRadios();
    try {
      settings = await api('/settings');
      renderCapture();
      renderProjects();
      await Promise.all([loadBackupInfo(), loadTrash()]);
    } catch (e) {
      $('#capture-list').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  function renderCapture() {
    $('#capture-list').innerHTML = Object.entries(CAPTURE_INFO).map(([k, [name, desc]]) => {
      const c = settings.capture[k] || { on: false, saved: 0, last: null };
      return `<div class="setting">
        <label class="switch"><input type="checkbox" role="switch" data-capture="${esc(k)}"${c.on ? ' checked' : ''} aria-describedby="cap-${esc(k)}"> <span>${esc(name)}</span> <span class="state">${c.on ? 'On' : 'Off'}</span></label>
        <p class="hint" id="cap-${esc(k)}">${esc(desc)}${c.saved ? ` Saved so far: ${esc(c.saved)}${c.last ? `, last ${esc(ago(c.last))}` : ''}.` : ''}</p>
      </div>`;
    }).join('');
  }

  async function setCapture(key, on, box) {
    box.disabled = true;
    try {
      await api('/settings', { method: 'PUT', body: { capture: { [key]: on } } });
      settings.capture[key].on = on;
      renderCapture();
      toast(`${CAPTURE_INFO[key][0]}: ${on ? 'on' : 'off'}`);
      focusSoon($(`[data-capture="${CSS.escape(key)}"]`));
    } catch (e) { box.checked = !on; toast(e.message, true); } finally { box.disabled = false; }
  }

  async function syncNow(btn) {
    btn.disabled = true;
    $('#sync-status').textContent = 'Saving… this can take a minute.';
    try {
      const r = await api('/sync/run', { method: 'POST' });
      $('#sync-status').textContent = r.ran.length ? `${r.note} (${r.ran.join(', ')})` : r.note;
      if (r.ran.length) await loadSettings();
    } catch (e) { $('#sync-status').textContent = ''; toast(e.message, true); } finally { btn.disabled = false; }
  }

  async function loadBackupInfo() {
    const [{ backups }, s] = await Promise.all([api('/backups'), settings ? Promise.resolve(settings) : api('/settings')]);
    settings = s;
    const pp = s.backup.passphrase;
    const cloud = s.backup.cloud.folder ? 'Google Drive folder' : s.backup.cloud.api ? 'Google Drive' : null;
    const last = backups[0];
    $('#backup-info').innerHTML = `
      <p>${last ? `Last backup on this computer: <b>${esc(ago(last.modified))}</b> (${esc(backups.length)} kept).` : 'There is no backup yet. Choose “Back up now”.'}</p>
      <p>Copy in the cloud: <b>${cloud ? esc(cloud) : 'Off'}</b>. ${cloud ? '' : 'Your data never leaves this computer. To keep a copy in Google Drive, see docs/google-drive.md.'}</p>
      <p>Backups locked with a passphrase: <b>${pp.set ? `Yes${pp.via === 'env' ? ' (from a computer setting)' : ''}` : 'No'}</b>.${!pp.set && cloud ? ' <span class="error">A cloud backup will not run until you set one below.</span>' : ''}</p>`;
  }

  async function savePassphrase(ev) {
    ev.preventDefault();
    const err = $('#bp-error');
    const fail = (m) => { err.textContent = m; err.hidden = false; err.focus?.(); };
    const a = $('#bp-1').value, b = $('#bp-2').value;
    if (a.length < 10) return fail('Use at least 10 characters.');
    if (a !== b) return fail('The two passphrases are not the same. Type the second one again.');
    try {
      await api('/settings/passphrase', { method: 'PUT', body: { passphrase: a, confirm: b } });
      err.hidden = true; $('#bp-1').value = ''; $('#bp-2').value = '';
      toast('Passphrase saved. Write it down somewhere safe.');
      settings = null; await loadBackupInfo();
    } catch (e) { fail(e.message); }
  }

  function renderProjects() {
    const list = settings.projects || [];
    $('#project-list').innerHTML = list.length
      ? `<ul class="plain">${list.map((p, i) => `<li><span dir="auto"><b>${esc(p.name)}</b>${p.match?.length ? ` <span class="muted">· ${esc(p.match.join(', '))}</span>` : ''}</span> <button type="button" class="btn sm ghost" data-action="remove-project" data-i="${i}" aria-label="Remove project ${esc(p.name)}">Remove</button></li>`).join('')}</ul>`
      : '<p class="muted">No projects yet.</p>';
  }
  async function saveProjects(next, okMsg) {
    try {
      await api('/settings', { method: 'PUT', body: { projects: next } });
      settings.projects = next; renderProjects(); toast(okMsg);
      return true;
    } catch (e) { toast(e.message, true); return false; }
  }
  async function addProject(ev) {
    ev.preventDefault();
    const err = $('#pj-error');
    const name = $('#pj-name').value.trim();
    if (!name) { err.textContent = 'Give the project a name.'; err.hidden = false; return; }
    err.hidden = true;
    const match = $('#pj-words').value.split(',').map((x) => x.trim()).filter(Boolean);
    if (await saveProjects([...(settings.projects || []), { name, match: match.length ? match : [name.toLowerCase()], tags: '' }], `Added ${name}`)) {
      $('#pj-name').value = ''; $('#pj-words').value = ''; focusSoon($('#pj-name'));
    }
  }

  async function loadTrash() {
    const { items } = await api('/trash');
    $('#trash-list').innerHTML = items.length
      ? `<ul class="plain">${items.map((i) => `<li><span dir="auto">${esc(i.title || 'Untitled')} <span class="muted small">· deleted ${esc(ago(i.deleted_at))}</span></span> <button type="button" class="btn sm" data-action="put-back" data-id="${esc(i.id)}" aria-label="Put back: ${esc(i.title || 'Untitled')}">Put back</button></li>`).join('')}</ul>`
      : '<p class="muted">Nothing has been deleted recently.</p>';
  }

  async function exportAll() {
    try {
      const token = store.get(TOKEN_KEY, 'sessionStorage');
      const res = await fetch('/export', { headers: token ? { authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error('Could not prepare the download.');
      download(`memvault-export-${new Date().toISOString().slice(0, 10)}.json`, await res.text());
      toast('Downloaded. The file holds all your notes in plain text, so keep it somewhere private.');
    } catch (e) { toast(e.message, true); }
  }

  async function wipeGo() {
    const err = $('#wipe-error');
    try {
      const r = await api('/clear', { method: 'POST', body: { confirm: 'DELETE ALL' } });
      dlg('dlg-wipe').close();
      toast(`Everything was deleted (${r.deleted} memories). A backup was made first${r.backup ? `: ${r.backup}` : ''}.`);
      mem.rows = [];
      await loadSettings();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  }

  /* ───────── one delegated click handler ───────── */
  const actions = {
    theme: toggleTheme,
    'text-smaller': () => { textLevel = setTextSize(textLevel - 1); toast(`Text size ${textLevel + 1} of ${SIZES.length}`); syncLookRadios(); },
    'text-larger': () => { textLevel = setTextSize(textLevel + 1); toast(`Text size ${textLevel + 1} of ${SIZES.length}`); syncLookRadios(); },
    help: () => { showView('memory', { focus: true }); store.del('memvault-guide'); $('#guide').hidden = false; },
    'dismiss-guide': () => { store.set('memvault-guide', 'hidden'); $('#guide').hidden = true; focusSoon($('#diary-input')); },
    'connect-apps': openApps,
    'pick-app': (el) => pickApp(el.dataset.app),
    'copy-sample': () => copyText('Remember that I prefer short answers.', 'Copied. Paste it into your AI app.'),
    view: (el) => showView(el.dataset.view, { focus: true }),
    filter: (el) => {
      mem.type = el.dataset.type;
      $$('.chip[data-action="filter"]').forEach((c) => { c.classList.toggle('is-active', c === el); c.setAttribute('aria-pressed', String(c === el)); });
      loadEntries().catch((e) => toast(e.message, true));
    },
    'clear-search': () => { mem.q = ''; $('#search-input').value = ''; loadEntries().catch((e) => toast(e.message, true)); },
    starter: async () => {
      try {
        const r = await api('/agents/starter', { method: 'POST', body: { pack: $('#pack-select').value || 'general' } });
        toast(r.installed.length ? `Added: ${r.installed.join(', ')}` : 'Those agents are already here');
        await loadAgents();
      } catch (e) { toast(e.message, true); }
    },
    'new-agent': () => { $('#agent-name').value = ''; $('#agent-prompt').value = ''; showAgentDialog({ title: 'New agent from a description', step: 'draft' }); },
    draft: draftAgent,
    'save-agent': saveAgent,
    'edit-agent': async (el) => {
      try { const { agent } = await api(`/agents/${encodeURIComponent(el.dataset.id)}`); showAgentDialog({ title: `Edit ${agent.name}`, step: 'edit', profile: agent, isNew: false }); }
      catch (e) { toast(e.message, true); }
    },
    'copy-brief': async (el) => {
      try { const r = await api(`/agents/${encodeURIComponent(el.dataset.id)}/brief`); await copyText(r.briefing, 'Instructions copied. Paste them into any AI to make it this helper.'); }
      catch (e) { toast(e.message, true); }
    },
    'copy-mcp': async (el) => {
      try { const r = await api(`/agents/${encodeURIComponent(el.dataset.id)}/mcp-config`); await copyText(JSON.stringify(r.config, null, 2), 'Connection settings copied. Add them to your AI app.'); }
      catch (e) { toast(e.message, true); }
    },
    'delete-agent': (el) => {
      deletingId = el.dataset.id;
      const a = agentCache.find((x) => x.id === deletingId);
      $('#delete-text').textContent = `“${a?.name || deletingId}” will be removed. Memories it wrote to the shared notebook stay.`;
      $('#delete-purge').checked = false;
      dlg('dlg-delete').showModal();
    },
    'confirm-delete': async () => {
      try { await api(`/agents/${encodeURIComponent(deletingId)}${$('#delete-purge').checked ? '?purge=1' : ''}`, { method: 'DELETE' }); dlg('dlg-delete').close(); toast('Agent deleted'); await loadAgents(); focusSoon($('#h-agents')); }
      catch (e) { toast(e.message, true); }
    },
    'close-dialog': (el) => { const d = el.closest('dialog'); if (d) { if (d.hasAttribute('data-guard')) closeDialog(d); else d.close(); } },
    'copy-text': () => copyText($('#text-body').value, 'Copied'),
    'add-secret': openAddSecret,
    lock,
    reveal: (el) => reveal(el.dataset.id),
    'show-value': (el) => {
      const span = $(`#rv-${el.dataset.i}`);
      const shown = el.textContent === 'Hide';
      span.textContent = shown ? '••••••••' : span.dataset.real;
      el.textContent = shown ? 'Show' : 'Hide';
      el.setAttribute('aria-label', `${shown ? 'Show' : 'Hide'} ${el.dataset.name}`); // the spoken name keeps matching the visible word
    },
    'delete-secret': async (el) => {
      const row = el.closest('.secret-row');
      if (!window.confirm('Delete this secret? This cannot be undone.')) return;
      try {
        await api(`/secrets/delete/${encodeURIComponent(el.dataset.id)}`, { method: 'DELETE', body: { password: vaultPw } });
        await loadSecrets();
        toast('Secret deleted');
        focusSoon($('#secrets .secret') || $('#h-secrets'));
      } catch (e) { toast(e.message, true); }
      void row;
    },
    'copy-value': (el) => copyText(el.dataset.value, 'Copied'),
    'reload-security': loadSecurity,
    'backup-now': (el) => backupNow(el),
    'dismiss-error': dismissErr,
    /* memory */
    'open-item': (el) => openItem(el.dataset.id),
    'edit-item': (el) => openItem(el.dataset.id, true),
    'pin-item': (el) => togglePin(el.dataset.id, el.getAttribute('aria-pressed') === 'true'),
    'delete-item': (el) => deleteItem(el.dataset.id),
    'mem-edit': () => showMemoryDialog(mem.current, { edit: true }),
    'mem-save': saveMemory,
    'mem-pin': async () => { const it = mem.current; await togglePin(it.id, isPinned(it)); try { showMemoryDialog(await fetchItem(it.id)); } catch { /* list reloaded */ } },
    'mem-delete': () => deleteItem(mem.current.id),
    'mem-download': () => download(`memvault-${fileSafe(titleOf(mem.current))}.json`, JSON.stringify(mem.current, null, 2)),
    undo: doUndo,
    'select-mode': toggleSelectMode,
    'select-all': () => { mem.rows.forEach((r) => mem.selected.add(r.id)); renderEntries(mem.rows); },
    pick: (el) => { if (el.checked) mem.selected.add(el.dataset.id); else mem.selected.delete(el.dataset.id); el.closest('.entry').classList.toggle('is-picked', el.checked); updateSelection(); },
    'delete-selected': openBulk,
    'bulk-go': bulkGo,
    /* settings */
    'sync-now': syncNow,
    'export-all': exportAll,
    'wipe-all': () => { $('#wipe-confirm').value = ''; $('#wipe-go').disabled = true; $('#wipe-error').hidden = true; dlg('dlg-wipe').showModal(); focusSoon($('#wipe-confirm')); },
    'wipe-go': wipeGo,
    'remove-project': (el) => saveProjects((settings.projects || []).filter((_, i) => i !== Number(el.dataset.i)), 'Project removed').then(() => focusSoon($('#pj-name'))),
    'put-back': async (el) => {
      try { await api(`/items/${encodeURIComponent(el.dataset.id)}/restore`, { method: 'POST' }); toast('Put back.'); await loadTrash(); focusSoon($('#h-settings')); }
      catch (e) { toast(e.message, true); }
    },
  };

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-action]');
    if (el) { actions[el.dataset.action]?.(el, ev); return; }
    // clicking beside a read-only window (not a form) closes it
    if (ev.target instanceof HTMLDialogElement && ev.target.classList.contains('closable') && !ev.target.hasAttribute('data-guard')) ev.target.close();
  });

  /* ───────── wiring ───────── */
  $('#composer').addEventListener('submit', saveDiary);
  $('#diary-input').addEventListener('input', (e) => { const n = e.target.value.length; $('#char-count').textContent = n === 1 ? '1 character' : `${n.toLocaleString()} characters`; });
  $('#diary-input').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') saveDiary(e); });
  $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); mem.q = $('#search-input').value.trim(); loadEntries().catch((x) => toast(x.message, true)); });
  $('#viewas').addEventListener('change', (e) => { mem.viewAs = e.target.value; loadEntries().catch((x) => toast(x.message, true)); });
  $('#unlock-form').addEventListener('submit', unlock);
  $('#show-pw').addEventListener('change', (e) => { $('#master-pw').type = e.target.checked ? 'text' : 'password'; $('#master-pw2').type = e.target.checked ? 'text' : 'password'; });
  $('#s-category').addEventListener('change', renderSecretFields);
  $('#pack-select').addEventListener('change', showPackDesc);
  $('#agent-json').addEventListener('input', () => { jsonDirty = true; });
  $('#secret-form').addEventListener('submit', saveSecret);
  $('#pass-form').addEventListener('submit', savePassphrase);
  $('#bp-show').addEventListener('change', (e) => { $('#bp-1').type = e.target.checked ? 'text' : 'password'; $('#bp-2').type = e.target.checked ? 'text' : 'password'; });
  $('#project-form').addEventListener('submit', addProject);
  $('#capture-list').addEventListener('change', (e) => { const k = e.target.dataset?.capture; if (k) setCapture(k, e.target.checked, e.target); });
  $$('input[name="textsize"]').forEach((r) => r.addEventListener('change', () => { textLevel = setTextSize(Number(r.value)); }));
  $$('input[name="theme"]').forEach((r) => r.addEventListener('change', () => applyTheme(r.value)));
  $('#bulk-confirm').addEventListener('input', (e) => { $('#bulk-go').disabled = e.target.value.trim() !== `DELETE ${mem.selected.size}`; });
  $('#bulk-form').addEventListener('submit', (e) => { e.preventDefault(); if (!$('#bulk-go').disabled) bulkGo(); });
  $('#wipe-confirm').addEventListener('input', (e) => { $('#wipe-go').disabled = e.target.value.trim() !== 'DELETE ALL'; });
  $('#wipe-form').addEventListener('submit', (e) => { e.preventDefault(); if (!$('#wipe-go').disabled) wipeGo(); });
  $('#connect-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = $('#token-input').value.trim();
    const err = $('#token-error');
    if (!t) { err.textContent = 'Paste your dashboard key first.'; err.hidden = false; return; }
    try {
      const r = await fetch('/whoami', { headers: { authorization: `Bearer ${t}` } });
      if (!r.ok) throw new Error('bad key');
    } catch {
      err.textContent = 'That key did not work. In a terminal, run “memvault token” and copy the whole line.';
      err.hidden = false;
      return;
    }
    err.hidden = true;
    store.set(TOKEN_KEY, t, 'sessionStorage');
    $('#token-input').value = '';
    dlg('dlg-connect').close();
    showView($('.tab.is-active')?.dataset.view || 'memory');
  });
  // closing the memory window by Esc or Cancel also forgets the half-typed edit
  dlg('dlg-memory').addEventListener('close', () => { markClean(dlg('dlg-memory')); });

  fetch('/health').then((r) => setOnline(r.ok)).catch(() => setOnline(false));
  syncLookRadios();
  if (!store.get(TOKEN_KEY, 'sessionStorage')) openConnect();
  showView('memory');
})();
