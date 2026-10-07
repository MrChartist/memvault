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
  document.documentElement.lang = navigator.language || 'en';

  // Text size: respects the browser's own setting, and lets anyone go larger. Remembered per browser.
  const SIZES = ['', 'm', 'l', 'xl'];
  function setTextSize(i) {
    const level = Math.max(0, Math.min(SIZES.length - 1, i));
    if (SIZES[level]) document.documentElement.dataset.text = SIZES[level]; else delete document.documentElement.dataset.text;
    store.set('memvault-text', String(level));
    return level;
  }
  let textLevel = setTextSize(Number(store.get('memvault-text')) || 0);

  let toastTimer;
  function toast(msg, isErr = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `show${isErr ? ' err' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, 3400);
  }

  const fmtTime = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(+d) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
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
      throw new Error('Cannot reach the MemVault server. Is it running? (memvault serve)');
    }
    setOnline(true);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && res.headers.get('www-authenticate')) {
      openConnect();
      throw new Error('Connect to your vault first.');
    }
    if (!res.ok) {
      const e = new Error(typeof data.error === 'string' ? data.error : 'Request failed');
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

  /* ───────── theme + tabs ───────── */
  function toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    store.set('memvault-theme', next);
  }

  const loaders = { memory: loadMemory, agents: () => { loadAgents(); loadPacks(); }, vault: () => {}, security: loadSecurity };
  function showView(name) {
    $$('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
    $$('.tab').forEach((t) => {
      const on = t.dataset.view === name;
      t.classList.toggle('is-active', on);
      if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
    loaders[name]?.();
  }

  /* ───────── memory ───────── */
  const mem = { type: '', viewAs: '', q: '' };

  async function loadMemory() {
    try {
      const [stats, agents] = await Promise.all([api('/stats'), api('/agents')]);
      renderStats(stats);
      fillViewAs(agents.agents);
      $('#guide').hidden = store.get('memvault-guide') === 'hidden';
      await loadEntries();
    } catch (e) {
      $('#entries').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
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
    const p = new URLSearchParams();
    if (mem.type) p.set('type', mem.type);
    if (mem.viewAs) p.set('agent', mem.viewAs);
    let path;
    if (mem.q) { p.set('q', mem.q); path = `/search?${p}`; } else { p.set('limit', '100'); path = `/list?${p}`; }
    const { results } = await api(path);
    renderEntries(results);
  }

  function renderEntries(rows) {
    const box = $('#entries');
    if (!rows.length) {
      box.innerHTML = `<div class="empty">${mem.q ? `Nothing found for “${esc(mem.q)}”.` : 'No memories yet. Write a note above, or connect an AI app and ask it to remember something.'}</div>`;
      return;
    }
    box.innerHTML = rows.map((e) => {
      const priv = e.scope && e.scope !== 'shared';
      return `<article class="entry">
        <div class="entry-head">
          <span class="badge t-${esc(e.type)}">${esc(e.type)}</span>
          ${e.agent_id ? `<span class="badge by-agent">${esc(e.agent_id)}</span>` : ''}
          ${priv ? `<span class="badge priv">${esc(e.scope.startsWith('agent:') ? 'private' : e.scope)}</span>` : ''}
          ${e.source ? `<span>${esc(e.source)}</span>` : ''}
          <time datetime="${esc(e.created_at)}">${esc(fmtTime(e.created_at))}</time>
        </div>
        <h3 dir="auto">${esc(e.title || 'Untitled')}</h3>
        ${e.snippet ? `<p dir="auto">${esc(e.snippet)}</p>` : ''}
      </article>`;
    }).join('');
  }

  async function saveDiary(ev) {
    ev.preventDefault();
    const input = $('#diary-input');
    const text = input.value.trim();
    if (!text) return toast('Write a note first.', true);
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
      $('#char-count').textContent = '0 / 5000';
      const masked = r.redacted?.length ? ` (masked ${r.redacted.map((x) => `${x.count}× ${x.type}`).join(', ')})` : '';
      toast(`Note saved${masked}`);
      mem.q = ''; $('#search-input').value = '';
      await loadMemory();
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
    }
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
        return `<article class="card agent">
          <div><h3 dir="auto">${esc(p.name)}</h3><span class="id">${esc(p.id)}</span></div>
          <p class="role" dir="auto">${esc(p.role) || '<span class="muted">No job described yet</span>'}</p>
          <div class="meta">
            <span class="badge">${esc(n)} ${n === 1 ? 'memory' : 'memories'}</span>
            <span class="badge">${esc(p.rules.always.length)} always-rules</span>
            <span class="badge">${esc(p.rules.never.length)} never-rules</span>
            ${p.brand.handle || p.brand.site ? `<span class="badge brand">${esc(p.brand.handle || p.brand.site)}</span>` : ''}
            ${wide ? '<span class="badge warnflag" title="This agent has wider access than the default">wide access</span>' : ''}
          </div>
          <div class="actions">
            <button class="btn sm primary" data-action="copy-brief" data-id="${esc(p.id)}">Copy briefing</button>
            <button class="btn sm" data-action="copy-mcp" data-id="${esc(p.id)}">Copy MCP config</button>
            <button class="btn sm" data-action="edit-agent" data-id="${esc(p.id)}">Edit</button>
            <button class="btn sm ghost" data-action="delete-agent" data-id="${esc(p.id)}">Delete</button>
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
    if (!d.open) d.showModal();
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
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    let profile;
    try { profile = readAgentForm(); } catch (e) { return fail(`The JSON is not valid: ${e.message}`); }
    if (agentIsNew && agentCache.some((a) => a.id === profile.id)) {
      return fail(`An agent with the short id "${profile.id}" already exists. Choose a different short id so it is not replaced.`);
    }
    try {
      const r = await api(`/agents/${encodeURIComponent(profile.id)}`, { method: 'PUT', body: profile });
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
    { id: 'claude-desktop', name: 'Claude Desktop', file: { win: '%APPDATA%\\Claude\\claude_desktop_config.json', mac: '~/Library/Application Support/Claude/claude_desktop_config.json', linux: '~/.config/Claude/claude_desktop_config.json' }, how: 'Open that file (in Claude Desktop it is usually under Settings → Developer → Edit Config). Add the block below inside "mcpServers", save, then restart the app.' },
    { id: 'cursor', name: 'Cursor', file: '~/.cursor/mcp.json', how: 'Create or open that file and add the block below inside "mcpServers". You can also use Cursor Settings → MCP.' },
    { id: 'claude-code', name: 'Claude Code (terminal)', command: true, how: 'Paste this command into your terminal and press Enter.' },
    { id: 'antigravity', name: 'Antigravity', file: '~/.gemini/antigravity/mcp_config.json', how: 'Open that file and add the block below inside "mcpServers", then restart Antigravity.' },
    { id: 'vscode', name: 'VS Code (Cline / Roo)', file: "the extension's MCP settings file", how: 'Open the extension, choose its MCP Servers screen, and edit the settings file it shows. Add the block below inside "mcpServers".' },
    { id: 'other', name: 'Another app', command: false, how: 'Any app that supports MCP lets you add a server by giving it a command and arguments. Use the values in this block.' },
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
      const cmd = `claude mcp add --transport stdio ${env} memvault -- ${q(entry.command)} ${entry.args.map(q).join(' ')}`.replace(/\s+/g, ' ');
      block += `<div class="code" tabindex="0" role="region" aria-label="Command to run">${esc(cmd)}</div><button type="button" class="btn primary" data-action="copy-value" data-value="${esc(cmd)}">Copy the command</button>`;
    } else {
      block += `<p class="label">Paste this</p><div class="code" tabindex="0" role="region" aria-label="Settings to paste">${esc(json)}</div><button type="button" class="btn primary" data-action="copy-value" data-value="${esc(json)}">Copy</button>`;
    }
    block += '<p class="hint">To give an app its own agent, with its own limited view of your memory, use Agents → Copy MCP config instead.</p>';
    $('#apps-body').innerHTML = block;
  }

  /* ───────── secure vault ───────── */
  let vaultPw = null;
  const CAT = {
    apikey: ['API keys', [['key', 'API key'], ['env', 'Environment'], ['notes', 'Notes']]],
    password: ['Passwords', [['username', 'Username / email'], ['password', 'Password'], ['url', 'Website'], ['notes', 'Notes']]],
    userid: ['User IDs', [['userid', 'User ID'], ['service', 'Service'], ['notes', 'Notes']]],
    payment: ['Payment details', [['label', 'Card label'], ['last4', 'Last 4 digits'], ['expiry', 'Expiry (MM/YY)'], ['notes', 'Notes']]],
    phone: ['Phone numbers', [['name', 'Name'], ['number', 'Number'], ['notes', 'Notes']]],
    custom: ['Custom', [['value', 'Value'], ['notes', 'Notes']]],
  };

  async function unlock(ev) {
    ev.preventDefault();
    const pw = $('#master-pw').value;
    if (!pw) return;
    const err = $('#pw-error');
    try {
      await api('/secrets/verify', { method: 'POST', body: { password: pw } });
      vaultPw = pw;
      err.hidden = true;
      $('#master-pw').value = '';
      $('#lock').hidden = true;
      $('#unlocked').hidden = false;
      await loadSecrets();
    } catch (e) {
      err.textContent = e.status === 429 ? e.message : e.status === 401 ? 'Wrong password.' : e.message;
      err.hidden = false;
    }
  }

  function lock() {
    vaultPw = null;
    $('#unlocked').hidden = true;
    $('#lock').hidden = false;
    $('#secrets').innerHTML = '';
  }

  async function loadSecrets() {
    const { secrets } = await api('/secrets/list');
    const box = $('#secrets');
    if (!secrets.length) { box.innerHTML = '<div class="empty">No secrets yet. Choose “Add secret”.</div>'; return; }
    const groups = {};
    for (const s of secrets) (groups[s.category] ||= []).push(s);
    box.innerHTML = Object.entries(groups).map(([cat, items]) => `
      <div class="cat"><div class="label">${esc(CAT[cat]?.[0] || cat)}</div>
        ${items.map((s) => `<button class="secret" data-action="reveal" data-id="${esc(s.id)}">
          <span class="grow"><b>${esc(s.label)}</b><small>Updated ${esc(new Date(s.updated_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }))}</small></span>
          <span class="btn sm ghost" data-action="delete-secret" data-id="${esc(s.id)}">Delete</span>
        </button>`).join('')}
      </div>`).join('');
  }

  async function reveal(id) {
    try {
      const d = await api('/secrets/get', { method: 'POST', body: { id, password: vaultPw } });
      $('#reveal-title').textContent = d.label;
      $('#reveal-fields').innerHTML = Object.entries(d.fields).map(([k, v]) =>
        `<div class="reveal"><div class="k">${esc(k)}</div><button type="button" class="v" data-action="copy-value" data-value="${esc(v)}">${esc(v)}</button></div>`).join('');
      dlg('dlg-reveal').showModal();
    } catch (e) { toast(e.status === 429 ? e.message : 'Could not decrypt.', true); }
  }

  function openAddSecret() {
    const sel = $('#s-category');
    sel.innerHTML = Object.entries(CAT).map(([k, [name]]) => `<option value="${esc(k)}">${esc(name)}</option>`).join('');
    renderSecretFields();
    $('#s-label').value = '';
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
    if (!label) return toast('Give it a label.', true);
    const fields = {};
    $$('#s-fields input').forEach((i) => { if (i.value.trim()) fields[i.dataset.field] = i.value.trim(); });
    if (!Object.keys(fields).length) return toast('Fill in at least one field.', true);
    try {
      await api('/secrets/add', { method: 'POST', body: { password: vaultPw, category, label, fields } });
      dlg('dlg-secret').close();
      toast('Encrypted and saved');
      await loadSecrets();
    } catch (e) { toast(e.message, true); }
  }

  /* ───────── security ───────── */
  const ICON = { ok: '✓', warn: '!', bad: '✕', info: 'i' };

  async function loadSecurity() {
    try {
      const [status, audit, backups] = await Promise.all([api('/status?deep=1'), api('/audit?limit=15'), api('/backups')]);
      $('#posture').innerHTML = status.rows.map((r) =>
        `<div class="check-row"><span class="ico ${esc(r.level)}">${ICON[r.level] || ''}</span><div><div>${esc(r.title)}</div>${r.fix ? `<div class="fix">${esc(r.fix)}</div>` : ''}</div></div>`).join('') +
        `<div class="check-row"><span class="ico ${status.counts.bad ? 'bad' : status.counts.warn ? 'warn' : 'ok'}">${status.counts.bad ? '✕' : status.counts.warn ? '!' : '✓'}</span><div><b>${status.counts.bad ? `${status.counts.bad} problem(s)` : 'No problems'}${status.counts.warn ? `, ${status.counts.warn} warning(s)` : ''}</b></div></div>`;

      const pill = $('#chain-pill');
      pill.className = `pill ${audit.chain.ok ? 'good' : 'bad'}`;
      pill.textContent = audit.chain.ok ? `Log intact · ${audit.chain.entries} records` : `Log altered at line ${audit.chain.brokenAtLine}`;
      $('#audit').innerHTML = audit.recent.length
        ? `<table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody>${audit.recent.slice().reverse().map((r) => {
            const d = r.detail || {};
            const what = d.tool ? `${r.action}: ${d.tool}` : r.action;
            const more = Object.entries(d).filter(([k]) => k !== 'tool').map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`).join(' ');
            return `<tr><td class="time">${esc(fmtTime(r.ts))}</td><td>${esc(r.actor)}</td><td>${esc(what)}</td><td class="muted">${esc(more)}</td></tr>`;
          }).join('')}</tbody></table>`
        : '<div class="empty">No activity recorded yet.</div>';

      $('#backups').innerHTML = backups.backups.length
        ? backups.backups.slice(0, 6).map((b) => `<div class="check-row"><span class="ico ok">✓</span><div>${esc(b.name)} <span class="muted small">· ${esc((b.size / 1024).toFixed(0))} KB · ${esc(fmtTime(b.modified))}</span></div></div>`).join('')
        : '<div class="empty">No local backups yet.</div>';
    } catch (e) {
      $('#posture').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  async function backupNow(btn) {
    btn.disabled = true;
    try {
      const { results } = await api('/backup', { method: 'POST' });
      toast(results.map((r) => `${r.backend}: ${r.ok ? (r.encrypted ? 'ok (encrypted)' : 'ok') : r.error}`).join(' · '), results.some((r) => !r.ok));
      await loadSecurity();
    } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
  }

  /* ───────── one delegated click handler ───────── */
  const actions = {
    theme: toggleTheme,
    'text-smaller': () => { textLevel = setTextSize(textLevel - 1); toast(`Text size ${textLevel + 1} of ${SIZES.length}`); },
    'text-larger': () => { textLevel = setTextSize(textLevel + 1); toast(`Text size ${textLevel + 1} of ${SIZES.length}`); },
    help: () => { showView('memory'); store.del('memvault-guide'); $('#guide').hidden = false; window.scrollTo({ top: 0, behavior: 'smooth' }); },
    'dismiss-guide': () => { store.set('memvault-guide', 'hidden'); $('#guide').hidden = true; },
    'connect-apps': openApps,
    'pick-app': (el) => pickApp(el.dataset.app),
    'copy-sample': () => copyText('Remember that I prefer short answers.', 'Copied. Paste it into your AI app.'),
    view: (el) => showView(el.dataset.view),
    filter: (el) => {
      mem.type = el.dataset.type;
      $$('.chip').forEach((c) => { c.classList.toggle('is-active', c === el); c.setAttribute('aria-pressed', String(c === el)); });
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
      try { const r = await api(`/agents/${encodeURIComponent(el.dataset.id)}/brief`); await copyText(r.briefing, 'Briefing copied. Paste it into any AI to make it this agent.'); }
      catch (e) { toast(e.message, true); }
    },
    'copy-mcp': async (el) => {
      try { const r = await api(`/agents/${encodeURIComponent(el.dataset.id)}/mcp-config`); await copyText(JSON.stringify(r.config, null, 2), 'MCP config copied. Merge it into your AI client.'); }
      catch (e) { toast(e.message, true); }
    },
    'delete-agent': (el) => {
      deletingId = el.dataset.id;
      const a = agentCache.find((x) => x.id === deletingId);
      $('#delete-text').textContent = `“${a?.name || deletingId}” will be removed. Memories it wrote to the shared vault stay.`;
      $('#delete-purge').checked = false;
      dlg('dlg-delete').showModal();
    },
    'confirm-delete': async () => {
      try { await api(`/agents/${encodeURIComponent(deletingId)}${$('#delete-purge').checked ? '?purge=1' : ''}`, { method: 'DELETE' }); dlg('dlg-delete').close(); toast('Agent deleted'); await loadAgents(); }
      catch (e) { toast(e.message, true); }
    },
    'close-dialog': (el) => el.closest('dialog')?.close(),
    'copy-text': () => copyText($('#text-body').value, 'Copied'),
    'add-secret': openAddSecret,
    lock,
    reveal: (el) => reveal(el.dataset.id),
    'delete-secret': async (el, ev) => {
      ev.stopPropagation();
      if (!confirm('Delete this secret? This cannot be undone.')) return;
      try { await api(`/secrets/delete/${encodeURIComponent(el.dataset.id)}`, { method: 'DELETE', body: { password: vaultPw } }); await loadSecrets(); }
      catch (e) { toast(e.message, true); }
    },
    'copy-value': (el) => copyText(el.dataset.value, 'Copied'),
    'reload-security': loadSecurity,
    'backup-now': (el) => backupNow(el),
  };

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-action]');
    if (el) { actions[el.dataset.action]?.(el, ev); return; }
    // click on a dialog's backdrop closes it
    if (ev.target instanceof HTMLDialogElement) ev.target.close();
  });

  /* ───────── wiring ───────── */
  $('#composer').addEventListener('submit', saveDiary);
  $('#diary-input').addEventListener('input', (e) => { $('#char-count').textContent = `${e.target.value.length} / 5000`; });
  $('#diary-input').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') saveDiary(e); });
  $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); mem.q = $('#search-input').value.trim(); loadEntries().catch((x) => toast(x.message, true)); });
  $('#viewas').addEventListener('change', (e) => { mem.viewAs = e.target.value; loadEntries().catch((x) => toast(x.message, true)); });
  $('#unlock-form').addEventListener('submit', unlock);
  $('#s-category').addEventListener('change', renderSecretFields);
  $('#pack-select').addEventListener('change', showPackDesc);
  $('#agent-json').addEventListener('input', () => { jsonDirty = true; });
  $('#secret-form').addEventListener('submit', saveSecret);
  $('#connect-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = $('#token-input').value.trim();
    if (!t) return;
    store.set(TOKEN_KEY, t, 'sessionStorage');
    $('#token-input').value = '';
    dlg('dlg-connect').close();
    showView($('.tab.is-active')?.dataset.view || 'memory');
  });

  fetch('/health').then((r) => setOnline(r.ok)).catch(() => setOnline(false));
  if (!store.get(TOKEN_KEY, 'sessionStorage')) openConnect();
  showView('memory');
})();
