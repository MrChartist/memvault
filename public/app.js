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
  // A phone or tablet signed in with a pairing code keeps its own key, so it stays signed in (device-keys.mjs).
  const DEVICE_KEY = 'memvault-device-key';
  // The words on this page are English, so the page says so (a screen reader reads them with the right voice).
  // Notes written in other languages are marked on their own elements with dir="auto".

  // Text size: respects the browser's own setting, and lets anyone go larger. Remembered per browser.
  const SIZES = ['', 'm', 'l', 'xl'];
  const SIZE_NAMES = ['Normal', 'Large', 'Larger', 'Largest'];
  function setTextSize(i) {
    const level = Math.max(0, Math.min(SIZES.length - 1, i));
    if (SIZES[level]) document.documentElement.dataset.text = SIZES[level]; else delete document.documentElement.dataset.text;
    store.set('memvault-text', String(level));
    return level;
  }
  let textLevel = setTextSize(Number(store.get('memvault-text')) || 0);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const DOCS = 'https://github.com/MrChartist/memvault/blob/main/';
  const docLink = (file, text) => `<a href="${esc(DOCS + file)}" target="_blank" rel="noopener noreferrer">${esc(text)}<span class="sr-only"> (opens in a new tab)</span></a>`;

  /* ───────── header height ───────── */
  // The bar for choosing several memories sticks just below the header, so it needs the header's real height,
  // which changes with the screen width and the text size. On a phone with very large text the header would
  // cover too much of the screen, so there it scrolls away with the page instead.
  const topBar = $('.top');
  const tabsBar = $('.tabs');
  function measureHeader() {
    topBar.classList.remove('unstick');
    const h = Math.ceil(topBar.getBoundingClientRect().height);
    const unstick = window.innerWidth <= 560 && h > window.innerHeight * 0.3;
    topBar.classList.toggle('unstick', unstick);
    document.documentElement.style.setProperty('--head-h', `${unstick ? 0 : h}px`);
    markTabEdges();
  }
  // Tabs that do not fit scroll sideways; the cut edge fades so it is clear there are more.
  function markTabEdges() {
    const max = tabsBar.scrollWidth - tabsBar.clientWidth;
    tabsBar.classList.toggle('more-start', max > 1 && tabsBar.scrollLeft > 1);
    tabsBar.classList.toggle('more-end', max > 1 && tabsBar.scrollLeft < max - 1);
  }
  tabsBar.addEventListener('scroll', markTabEdges, { passive: true });
  // The chosen tab is always scrolled fully into sight (only the tab row moves, never the page).
  function revealTab(t) {
    const b = tabsBar.getBoundingClientRect();
    const r = t.getBoundingClientRect();
    if (r.left < b.left + 44) tabsBar.scrollLeft -= b.left + 44 - r.left;
    else if (r.right > b.right - 44) tabsBar.scrollLeft += r.right - (b.right - 44);
    markTabEdges();
  }
  // A tab reached with the keyboard is moved clear of the faded edge too, so its focus ring shows in full.
  tabsBar.addEventListener('focusin', (e) => { if (e.target.classList?.contains('tab')) revealTab(e.target); });
  if (window.ResizeObserver) new ResizeObserver(measureHeader).observe(topBar);
  window.addEventListener('resize', measureHeader);
  measureHeader();

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
  const getToken = () => store.get(TOKEN_KEY, 'sessionStorage') || store.get(DEVICE_KEY);
  const forgetToken = () => { store.del(TOKEN_KEY, 'sessionStorage'); store.del(DEVICE_KEY); };
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
    const token = getToken();
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
      forgetToken();
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
    if (!getToken()) e.preventDefault();
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
      if (on) { t.setAttribute('aria-current', 'page'); revealTab(t); } else t.removeAttribute('aria-current');
    });
    if (name !== 'vault') stopIdleLock();
    loaders[name]?.();
    // Moving to a new screen moves the cursor to its heading, so a screen reader announces where you are.
    if (focus) { const h = $(`#${name === 'vault' && !$('#unlocked').hidden ? 'h-secrets' : HEADINGS[name]}`); if (h) h.focus({ preventScroll: true }); window.scrollTo({ top: 0 }); }
  }

  /* ───────── memory ───────── */
  const mem = { type: '', viewAs: '', q: '', select: false, selected: new Set(), rows: [], current: null, empty: false };
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
  // Stored text keeps the "[REDACTED:kind]" marks that redact.mjs writes; on screen they read as plain words.
  // Display only: the stored text, and the text in the edit box, are never changed.
  const MARK_WORDS = { ...REDACT_WORDS, secret: 'password or key', password: 'password', 'quoted-secret': 'password or key', 'google-refresh-token': 'access key' };
  const friendly = (t) => String(t ?? '').replace(/\[REDACTED:([a-z0-9-]+)\]/gi, (_m, k) => `[hidden ${MARK_WORDS[k.toLowerCase()] || 'private detail'}]`);

  // Who or what saved a memory, in plain words. Unknown sources are shown as they are.
  const SOURCE_WORDS = {
    manual: 'You', 'ai-memory': 'Saved by an AI', mcp: 'Saved by an AI', 'agent-handoff': 'Handed over by an agent',
    clipboard: 'Copied text', git: 'Code commit', vscode: 'VS Code', filesystem: 'Changed files', files: 'Changed files', system: 'This computer',
    chrome: 'Chrome', edge: 'Edge', brave: 'Brave', chromium: 'Chromium', antigravity: 'Antigravity',
    chatgpt: 'ChatGPT', 'chatgpt-import': 'ChatGPT import', claude: 'Claude', 'claude-import': 'Claude import',
    gemini: 'Gemini', 'gemini-import': 'Gemini import', perplexity: 'Perplexity', 'perplexity-import': 'Perplexity import',
    cursor: 'Cursor', copilot: 'Copilot', cline: 'Cline',
  };
  function sourceWords(src) {
    const s = String(src || '');
    if (SOURCE_WORDS[s]) return SOURCE_WORDS[s];
    let m = s.match(/^prompt-(.+)$/); if (m) return `Prompt in ${sourceWords(m[1])}`;
    m = s.match(/^mcp:(.+)$/); if (m) return `From ${m[1]}`;
    m = s.match(/^(.+)-bookmarks$/); if (m) return `${sourceWords(m[1])} bookmarks`;
    return s;
  }
  // Agent ids become their names once the list of agents is known.
  const agentNames = new Map();
  const rememberAgents = (list) => { agentNames.clear(); (list || []).forEach((a) => agentNames.set(a.id, a.name || a.id)); };
  const agentName = (id) => agentNames.get(id) || id;
  // Labels MemVault adds by itself (the kind of memory, where it came from, and the pin) stay out of the edit box.
  const tagList = (t) => String(t || '').split(',').map((x) => x.trim()).filter(Boolean);
  const isOwnTag = (tag, item) => tag === 'pinned' || tag === item.type || tag === item.source;

  async function loadMemory() {
    try {
      const [stats, agents] = await Promise.all([api('/stats'), api('/agents'), loadSetup()]);
      rememberAgents(agents.agents);
      renderStats(stats);
      fillViewAs(agents.agents);
      await loadEntries();
    } catch (e) {
      $('#entries').innerHTML = `<div class="empty">${esc(e.message)}${/not running/.test(e.message) ? '' : ''}</div>`;
      $('#results-status').textContent = '';
    }
  }

  /* ───────── Getting started (setup-status.mjs): the list ticks itself from what is really there ───────── */
  const SAMPLE = 'Remember that I prefer short answers.';
  const SETUP_STEPS = {
    install: { title: 'Install MemVault', done: () => 'Done. It runs on this computer, and your notes stay here.' },
    connect: {
      title: 'Connect your AI app',
      todo: () => 'Works with Claude, Cursor, Antigravity, VS Code and other AI apps that can connect to tools. After you paste the settings, restart the app.',
      action: ['connect-apps', 'Show me how', { primary: true }],
      done: (s) => `Connected: ${s.apps.map((a) => esc(a.label)).join(', ')}.`,
      doneAction: ['connect-apps', 'Connect another app'],
    },
    try: {
      title: 'Ask it to remember something',
      todo: () => `In your AI app, say: <span class="sample" dir="auto">${esc(SAMPLE)}</span>`,
      action: ['copy-sample', 'Copy sentence'],
      done: (s) => `Your AI apps have saved ${plural(s.saved, 'memory', 'memories')} here.`,
    },
    backup: {
      title: 'Make your first backup',
      todo: () => 'A copy of your whole memory, kept in the backups folder on this computer.',
      action: ['backup-now', 'Back up now'],
      done: (s) => `Last backup ${esc(ago(s.last))}.`,
    },
    passphrase: {
      title: 'Lock your backups with a passphrase',
      todo: () => 'Needed before a backup can be copied to Google Drive. Write it down: nobody can recover it for you.',
      action: ['setup-go', 'Set a passphrase', { target: '#bp-1' }],
      done: () => 'Your backups are locked with your passphrase.',
    },
    agents: {
      title: 'Give an app its own helper',
      todo: () => 'Tie an app to one agent, such as Study Buddy, so it sees only that agent’s memory.',
      action: ['view', 'See the agents', { view: 'agents' }],
      done: (s) => `${s.apps.map((a) => `${esc(a.label)} works as ${esc(agentName(a.agent))}`).join(', ')}.`,
    },
    devices: {
      title: 'Use it on your other computers',
      todo: (s) => s.enabled ? 'Syncing is on, but no other computer has been seen yet. Use the same shared folder and sync passphrase on the others.' : 'Keep your Mac, Windows PC and server in step through a folder you share between them.',
      action: ['setup-go', 'Set up', { target: '#dv-folder' }],
      done: (s) => `In step with ${plural(s.others, 'other computer', 'other computers')}.`,
    },
    phone: {
      title: 'Open it on your phone',
      todo: () => 'Read and write notes on your iPhone or iPad, through a private address only your devices can reach.',
      action: ['setup-go', 'Set up', { target: '[data-action="pair-phone"]' }],
      done: (s) => `${plural(s.phones, 'phone or tablet', 'phones or tablets')} signed in.`,
    },
  };
  const setupButton = ([action, label, o = {}]) => `<div class="row"><button type="button" class="btn${o.primary ? ' primary' : ''}" data-action="${esc(action)}"${o.target ? ` data-target="${esc(o.target)}"` : ''}${o.view ? ` data-view="${esc(o.view)}"` : ''}>${esc(label)}</button></div>`;

  function renderSetup(s) {
    const item = (st) => {
      const d = SETUP_STEPS[st.id];
      if (!d) return '';
      const act = st.done ? d.doneAction : d.action;
      return `<li class="${st.done ? 'is-done' : 'is-todo'}"><div><b>${esc(d.title)}<span class="sr-only">${st.done ? ': done' : ': not done yet'}</span></b>
        <span class="muted">${st.done ? d.done(st) : d.todo(st)}</span>${act ? setupButton(act) : ''}</div></li>`;
    };
    $('#setup-steps').innerHTML = s.steps.filter((x) => !x.optional).map(item).join('');
    const extra = s.steps.filter((x) => x.optional);
    $('#setup-optional').innerHTML = extra.map(item).join('');
    $('#setup-optional-count').textContent = `(${extra.filter((x) => x.done).length} of ${extra.length} optional steps done)`;
    const all = s.done === s.total;
    $('#setup-bar').max = s.total;
    $('#setup-bar').value = s.done;
    $('#setup-count').textContent = all ? `All ${s.total} steps done` : `${s.done} of ${s.total} steps done`;
    $('#guide-title').textContent = all ? 'You are all set' : 'Getting started';
  }

  async function loadSetup() {
    const card = $('#guide');
    if (store.get('memvault-guide') === 'hidden') { card.hidden = true; return; }
    try {
      const s = await api('/setup');
      if (s.onPhone) { card.hidden = true; return; } // every step is done on a computer
      renderSetup(s);
      card.hidden = false;
    } catch {
      card.hidden = true; // the memory list below still loads and shows the problem
    }
  }

  // You paste the settings into your AI app and come back: the list is checked again then.
  window.addEventListener('focus', () => { if (!$('#view-memory').hidden && !$('#guide').hidden && getToken()) loadSetup(); });

  function setupGo(el) {
    showView('settings');
    const target = $(el.dataset.target);
    if (!target) return;
    target.closest('.card')?.scrollIntoView({ block: 'start' });
    focusSoon(target);
  }

  function renderStats(s) {
    // A new, empty vault shows one clear next step instead of rows of zeros and controls with nothing to act on.
    mem.empty = !s.total;
    $$('[data-needs-items]').forEach((el) => { el.hidden = mem.empty; });
    if (mem.empty && mem.select) { mem.select = false; mem.selected.clear(); }
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
    const vaultEmpty = mem.empty && !rows.length;
    $('#empty-state').hidden = !vaultEmpty;
    if (!rows.length) {
      box.innerHTML = vaultEmpty ? '' : `<div class="empty">${emptyMessage()}</div>`;
      updateSelection();
      return;
    }
    box.innerHTML = rows.map((e) => {
      const priv = e.scope && e.scope !== 'shared';
      const pinned = isPinned(e);
      const t = esc(friendly(titleOf(e)));
      const picked = mem.selected.has(e.id);
      return `<article class="entry${picked ? ' is-picked' : ''}${pinned ? ' is-pinned' : ''}" data-id="${esc(e.id)}">
        <div class="entry-head">
          ${mem.select ? `<label class="pick"><input type="checkbox" data-action="pick" data-id="${esc(e.id)}"${picked ? ' checked' : ''}> <span class="sr-only">Select: ${t}</span></label>` : ''}
          ${pinned ? '<span class="badge pinned">Pinned</span>' : ''}
          <span class="badge t-${esc(e.type)}">${esc(TYPE_LABEL[e.type] || e.type)}</span>
          ${e.agent_id ? `<span class="badge by-agent" dir="auto">${esc(agentName(e.agent_id))}</span>` : ''}
          ${priv ? `<span class="badge priv">${esc(e.scope.startsWith('agent:') ? 'Private' : e.scope)}</span>` : ''}
          ${e.source ? `<span dir="auto">${esc(sourceWords(e.source))}</span>` : ''}
          <time datetime="${esc(e.created_at)}">${esc(fmtTime(e.created_at))}</time>
        </div>
        <h3 dir="auto"><button type="button" class="linklike" data-action="open-item" data-id="${esc(e.id)}">${t}</button></h3>
        ${e.snippet ? `<p dir="auto">${esc(friendly(e.snippet))}</p>` : ''}
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
      toast(`Note saved${hid}.`);
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
    $('#mem-title').textContent = friendly(titleOf(item));
    $('#mem-meta').textContent = `${TYPE_LABEL[item.type] || item.type} · ${fmtDay(item.created_at)}${item.agent_id ? ` · written by ${agentName(item.agent_id)}` : ''}${item.source && item.source !== 'manual' ? ` · from ${sourceWords(item.source)}` : ''}${item.scope && item.scope !== 'shared' ? ' · private' : ''}${isPinned(item) ? ' · pinned' : ''}`;
    $('#mem-full').textContent = friendly(item.content) || '(No text)';
    $('#mem-pin').textContent = isPinned(item) ? 'Unpin' : 'Pin';
    $('#mem-view-step').hidden = edit;
    $('#mem-edit-step').hidden = !edit;
    $('#mem-error').hidden = true;
    if (edit) {
      $('#m-title').value = item.title || '';
      $('#m-content').value = item.content || '';
      $('#m-tags').value = tagList(item.tags).filter((x) => !isOwnTag(x, item)).join(', ');
    }
    if (!d.open) d.showModal();
    if (edit) {
      // A long title opens at its start, not scrolled to its end.
      const ti = $('#m-title');
      setTimeout(() => { ti.focus(); ti.setSelectionRange(0, 0); ti.scrollLeft = 0; }, 30);
    } else focusSoon($('#mem-full'));
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
      // The labels MemVault added itself are kept, and the pin is sent on its own, so editing tags never unpins.
      const own = tagList(it.tags).filter((x) => isOwnTag(x, it) && x !== 'pinned');
      const tags = [...new Set([...own, ...tagList($('#m-tags').value).filter((x) => x !== 'pinned')])].join(',');
      const r = await api(`/items/${encodeURIComponent(it.id)}`, { method: 'PATCH', body: { title, content, tags, pinned: isPinned(it) } });
      markClean(dlg('dlg-memory'));
      dlg('dlg-memory').close();
      toast(`Saved${r.redacted?.length ? ` (hid ${hidWords(r.redacted)})` : ''}.`);
      await loadMemory();
    } catch (e) { fail(`${e.message} What you typed is still here.`); }
  }

  async function togglePin(id, pinnedNow) {
    try {
      await api(`/items/${encodeURIComponent(id)}`, { method: 'PATCH', body: { pinned: !pinnedNow } });
      toast(pinnedNow ? 'Unpinned.' : 'Pinned. It will stay at the top.');
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
      showUndo(`Deleted “${friendly(titleOf(item || {}))}”.`, async () => { await api(`/items/${encodeURIComponent(id)}/restore`, { method: 'POST' }); });
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
    $('#bulk-label').innerHTML = `Type <code>DELETE ${esc(n)}</code> to confirm`;
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
      rememberAgents(agents);
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
            <div class="actions-main">
              <button class="btn sm primary" data-action="copy-brief" data-id="${esc(p.id)}" aria-label="Copy instructions for ${nm}">Copy instructions</button>
              <button class="btn sm" data-action="copy-mcp" data-id="${esc(p.id)}" aria-label="Copy connection settings for ${nm}">Copy connection settings</button>
            </div>
            <div class="actions-minor">
              <button class="btn sm ghost" data-action="edit-agent" data-id="${esc(p.id)}" aria-label="Edit ${nm}">Edit</button>
              <button class="btn sm ghost" data-action="delete-agent" data-id="${esc(p.id)}" aria-label="Delete ${nm}">Delete</button>
            </div>
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

  // Notes come from the draft reader (agents.mjs). Shown in the dashboard's own words: "agent", not "helper",
  // and a link to the guide instead of a tool name.
  function noteHtml(n) {
    const text = String(n).replace(/\bhelper\b/g, 'agent');
    if (!/agent_define/.test(text)) return esc(text);
    const rest = text.replace(/\s*For a deeper reading[^.]*agent_define\.?/, '').replace(/agent_define/g, 'the agent tool').trim();
    return `${esc(rest)}${rest ? ' ' : ''}For a more careful reading, ask your AI app to make the agent for you: ${docLink('docs/agents.md', 'how to do that')}.`;
  }

  function showAgentDialog({ title, step, profile, isNew, notes = [] }) {
    $('#agent-title').textContent = title;
    $('#agent-draft-step').hidden = step !== 'draft';
    $('#agent-edit-step').hidden = step !== 'edit';
    $('#agent-error').hidden = true;
    if (profile) fillAgentForm(profile, isNew);
    $('#agent-notes').innerHTML = notes.map((n) => `<li>${noteHtml(n)}</li>`).join('');
    const d = dlg('dlg-agent');
    if (!d.open) { markClean(d); d.showModal(); }
  }

  async function draftAgent() {
    const prompt = $('#agent-prompt').value.trim();
    if (!prompt) return toast('Describe the agent first.', true);
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
      return fail(`An agent with the short name “${profile.id}” already exists. Choose a different short name so it is not replaced.`);
    }
    try {
      const r = await api(`/agents/${encodeURIComponent(profile.id)}`, { method: 'PUT', body: profile });
      markClean(dlg('dlg-agent'));
      dlg('dlg-agent').close();
      toast(`Saved ${r.agent.name}.`);
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
    const count = (list) => plural(list.length, 'agent', 'agents');
    $('#pack-desc').textContent = id === 'all'
      ? `Adds every starter set (${count(packs.flatMap((x) => x.agents))}).`
      : p ? `${p.description || `Adds: ${p.agents.map((a) => a.name).join(', ')}.`} (${count(p.agents)})` : '';
  }

  /* ───────── connect an AI app ───────── */
  const OS = /Win/i.test(navigator.platform || navigator.userAgent) ? 'win' : /Mac/i.test(navigator.platform || navigator.userAgent) ? 'mac' : 'linux';
  // The block to paste already holds the "mcpServers" wrapper, so the steps say when to paste all of it and when only part.
  const PASTE_RULE = 'If the file is empty, paste all of this. If it already has “mcpServers”, copy only the “memvault” part into it.';
  const APPS = [
    { id: 'claude-desktop', name: 'Claude Desktop', file: { win: '%APPDATA%\\Claude\\claude_desktop_config.json', mac: '~/Library/Application Support/Claude/claude_desktop_config.json', linux: '~/.config/Claude/claude_desktop_config.json' }, how: 'Open that file. In Claude Desktop it is usually under Settings → Developer → Edit Config.', after: 'Save the file, then quit Claude completely and open it again.' },
    { id: 'cursor', name: 'Cursor', file: '~/.cursor/mcp.json', how: 'Create or open that file. You can also use Cursor Settings → MCP.', after: 'Save the file.' },
    { id: 'claude-code', name: 'Claude Code (terminal)', command: true, how: 'Paste this command into your terminal and press Enter.' },
    { id: 'antigravity', name: 'Antigravity', file: '~/.gemini/antigravity/mcp_config.json', how: 'Open that file.', after: 'Save the file, then restart Antigravity.' },
    { id: 'vscode', name: 'VS Code (Cline / Roo)', file: 'the extension’s MCP settings file', how: 'Open the extension, choose its MCP Servers screen, and edit the settings file it shows.', after: 'Save the file.' },
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
      block += `<div class="code" tabindex="0" role="region" aria-label="Command to run">${esc(cmd)}</div><div class="row"><button type="button" class="btn primary" data-action="copy-value" data-value="${esc(cmd)}">Copy command</button></div>`;
    } else {
      block += `<p class="label">Paste this</p>${app.file ? `<p>${esc(PASTE_RULE)}</p>` : ''}<div class="code" tabindex="0" role="region" aria-label="Settings to paste">${esc(json)}</div><div class="row"><button type="button" class="btn primary" data-action="copy-value" data-value="${esc(json)}">Copy connection settings</button></div>`;
      if (app.after) block += `<p class="apps-after">${esc(app.after)}</p>`;
    }
    block += '<p class="hint">To give an app its own agent, with its own limited view of your memory, use Agents → Copy connection settings instead.</p>';
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
      toast('Locked and saved.');
      await loadSecrets();
    } catch (e) { toast(e.message, true); }
  }

  /* ───────── security ───────── */
  const ICON = { ok: ['✓', 'OK'], warn: ['!', 'Warning'], bad: ['✕', 'Problem'], info: ['i', 'Note'] };

  /* The activity list in plain words. Every action written with audit({ action }) in server.mjs, ingest.mjs,
     mcp-server.mjs and cli-tools.mjs has a phrase here; anything new falls back to its own name. */
  const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
  const TOOL_WORDS = {
    vault_search: 'searched', vault_smart_search: 'searched', vault_add: 'saved a memory', vault_remember: 'saved a memory',
    vault_list: 'looked at recent memories', vault_get_context: 'looked up memories on a topic', vault_smart_context: 'looked up memories on a topic',
    vault_stats: 'checked how much is saved', vault_secret_list: 'looked at the names of secrets', vault_git_log: 'read code commits',
    vault_recent_files: 'read the list of changed files', vault_system_info: 'read facts about this computer', vault_projects: 'read your projects',
    vault_project_context: 'read about a project', vault_daily_digest: 'read today’s summary', vault_weekly_digest: 'read the weekly summary',
    vault_capture_prompt: 'saved a prompt', vault_log_conversation: 'saved a conversation', vault_ai_summarize: 'summarised memories',
    vault_ai_insights: 'looked for patterns', vault_backup: 'made a backup', vault_backups: 'looked at the backups',
    vault_bridge_list: 'looked at connected AI tools', vault_bridge_sync: 'brought in memories from other AI tools',
    agent_list: 'looked at the agents', agent_activate: 'switched to an agent', agent_define: 'created or changed an agent',
    agent_handoff: 'handed work to another agent', agent_inbox: 'checked its handoffs',
  };
  const RESOURCE_WORDS = { 'recent-entries': 'read recent memories', 'diary-entries': 'read recent notes', 'worklog-entries': 'read recent work logs', 'conversation-entries': 'read recent conversations', 'vault-stats': 'checked how much is saved' };
  const PROMPT_WORDS = { activate_agent: 'switched to an agent', user_context: 'read your history', project_summary: 'read about a project', daily_brief: 'read today’s summary' };
  const ACTOR_WORDS = { sync: 'Automatic saving', cli: 'You (command line)', 'chatgpt-import': 'ChatGPT import', 'claude-import': 'Claude import', 'gemini-import': 'Gemini import', 'perplexity-import': 'Perplexity import', antigravity: 'Antigravity' };
  const BACKENDS = { local: 'on this computer', gdriveFolder: 'Google Drive folder', gdriveApi: 'Google Drive' };
  const FIELD_WORDS = { title: 'title', content: 'text', tags: 'tags' };
  const KIND_WORDS = { diary: 'a note', conversation: 'a conversation', worklog: 'a work log', file: 'a file' };
  // "From …" in the activity list reads as a phrase, so a few sources get their own words there.
  const SOURCE_FROM = { 'ai-memory': 'an AI', mcp: 'an AI', 'agent-handoff': 'a handoff between agents', clipboard: 'copied text', git: 'code commits', filesystem: 'changed files', files: 'changed files', system: 'this computer' };
  const sourceFrom = (src) => SOURCE_FROM[src] || sourceWords(src);

  function auditWho(actor) {
    const a = String(actor || '');
    if (a === 'api' || a === 'owner') return 'You';
    if (agentNames.has(a)) return agentNames.get(a);
    if (ACTOR_WORDS[a]) return ACTOR_WORDS[a];
    if (CAPTURE_INFO[a]) return `${CAPTURE_INFO[a][0]} (automatic)`;
    if (a.startsWith('bridge:')) return `Bridge: ${sourceWords(a.slice(7))}`;
    return a;
  }
  // "1× secret-assignment, 2× github-token" (adds) or ["1x secret-assignment"] (edits) → "hid 1 password or key, 2 access keys"
  function hidFrom(v) {
    const parts = (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim().match(/^(\d+)\s*[x×]\s*(.+)$/)).filter(Boolean);
    return parts.length ? `hid ${hidWords(parts.map((m) => ({ count: Number(m[1]), type: m[2] })))}` : '';
  }
  const listWords = (arr, fn = (x) => x, max = 4) => { const l = (arr || []).map(fn).filter(Boolean); return l.length > max ? `${l.slice(0, max).join(', ')} and ${l.length - max} more` : l.join(', '); };

  function auditWhat(r) {
    const d = r.detail || {};
    const c = Number(d.count) || 0;
    const tool = d.tool && TOOL_WORDS[d.tool];
    const what = {
      add: () => `added ${KIND_WORDS[d.type] || 'a memory'}`,
      'add-many': () => `added ${plural(c, 'memory', 'memories')}`,
      edit: () => ((d.fields || []).every((f) => f === 'pinned') ? 'pinned or unpinned a memory' : 'edited a memory'),
      delete: () => (c > 1 ? `deleted ${c} memories` : 'deleted a memory'),
      restore: () => (c > 1 ? `put back ${c} memories` : 'put back a memory'),
      export: () => 'downloaded everything',
      clear: () => (d.scoped ? `deleted ${plural(Number(d.deleted) || 0, 'matching memory', 'matching memories')}` : 'deleted everything'),
      'secrets-denied': () => 'tried a wrong Secure Vault password',
      'secret-add': () => 'locked a new secret',
      'secret-get': () => 'opened a secret',
      'secret-delete': () => 'deleted a secret',
      'agent-starter': () => 'added starter agents',
      'agent-save': () => 'saved an agent',
      'agent-delete': () => 'deleted an agent',
      'agent-activate': () => 'switched to an agent',
      'agent-define': () => (d.updated ? 'changed an agent' : 'created an agent'),
      settings: () => ((d.changed || []).includes('backup-passphrase') ? 'set the backup passphrase' : 'changed settings'),
      sync: () => 'collected new memories',
      backup: () => (d.ok === false ? 'tried to make a backup' : 'made a backup'),
      'bridge-sync': () => 'brought in memories from other AI tools',
      scrub: () => 'hid passwords and keys in old memories',
      tool: () => tool || `used ${d.tool || 'a tool'}`,
      resource: () => RESOURCE_WORDS[d.resource] || 'read memories',
      prompt: () => PROMPT_WORDS[d.prompt] || 'used a ready-made prompt',
    }[r.action];
    return cap(what ? what() : String(r.action || '').replace(/[-_:]+/g, ' '));
  }

  // Short extra facts, only the ones that mean something to a person. Never raw key=value text.
  function auditMore(r) {
    const d = r.detail || {};
    const out = [];
    const backupFirst = () => { if (d.backup) out.push('a backup was made first'); };
    const agentWord = (id) => (id ? agentName(id) : '');
    switch (r.action) {
      case 'add': case 'add-many': {
        const from = (d.sources || []).filter((x) => x !== 'manual').map(sourceFrom);
        if (from.length) out.push(`from ${listWords(from)}`);
        out.push(hidFrom(d.redacted));
        break;
      }
      case 'edit': {
        const f = (d.fields || []).filter((x) => x !== 'pinned').map((x) => FIELD_WORDS[x] || x);
        if (f.length) out.push(`changed the ${listWords(f)}`);
        out.push(hidFrom(d.redacted));
        break;
      }
      case 'delete': case 'clear': backupFirst(); break;
      case 'export': if (d.count) out.push(plural(Number(d.count), 'memory', 'memories')); break;
      case 'secret-add': if (CAT[d.category]) out.push(CAT[d.category][0]); break;
      case 'agent-starter': {
        const n = (d.installed || []).length;
        out.push(n ? `${plural(n, 'agent', 'agents')}: ${listWords(d.installed, agentWord)}` : 'they were already here');
        break;
      }
      case 'agent-save': case 'agent-delete': out.push(agentWord(d.id)); break;
      case 'agent-activate': case 'agent-define': out.push(agentWord(d.agent)); break;
      case 'settings': out.push(listWords((d.changed || []).filter((x) => x !== 'backup-passphrase').map((x) => {
        const m = String(x).match(/^([a-z]+):(on|off)$/);
        if (m) return `${CAPTURE_INFO[m[1]]?.[0] || m[1]} ${m[2]}`;
        return x === 'projects' ? 'your projects' : x;
      }))); break;
      case 'sync': {
        out.push(listWords(d.ran, (k) => CAPTURE_INFO[k]?.[0] || k));
        if (d.exit !== undefined && String(d.exit) !== '0') out.push('it did not finish');
        break;
      }
      case 'backup': out.push(listWords(d.backends, (k) => BACKENDS[k] || k)); if (d.ok === false) out.push('it did not work'); break;
      case 'bridge-sync': out.push(listWords(d.bridges)); break;
      case 'scrub': if (d.items) out.push(plural(Number(d.items), 'memory', 'memories')); backupFirst(); break;
      default: break;
    }
    return cap(out.filter((x) => x && String(x).trim()).join(' · '));
  }

  async function loadSecurity() {
    try {
      const [status, audit, backups, agents] = await Promise.all([api('/status?deep=1'), api('/audit?limit=15'), api('/backups'), api('/agents').catch(() => ({ agents: [] }))]);
      rememberAgents(agents.agents);
      const ico = (lvl) => `<span class="ico ${esc(lvl)}" aria-hidden="true">${ICON[lvl]?.[0] || ''}</span><span class="sr-only">${esc(ICON[lvl]?.[1] || '')}: </span>`;
      $('#posture').innerHTML = status.rows.map((r) =>
        `<div class="check-row">${ico(r.level)}<div><div>${esc(r.title)}</div>${r.fix ? `<div class="fix">${esc(r.fix)}</div>` : ''}</div></div>`).join('') +
        `<div class="check-row">${ico(status.counts.bad ? 'bad' : status.counts.warn ? 'warn' : 'ok')}<div><b>${status.counts.bad ? `${status.counts.bad} ${status.counts.bad === 1 ? 'problem' : 'problems'}` : 'No problems'}${status.counts.warn ? `, ${status.counts.warn} ${status.counts.warn === 1 ? 'warning' : 'warnings'}` : ''}</b></div></div>`;

      const pill = $('#chain-pill');
      pill.className = `pill ${audit.chain.ok ? 'good' : 'bad'}`;
      pill.textContent = audit.chain.ok ? `Log intact · ${plural(audit.chain.entries, 'record', 'records')}` : 'The activity list was changed by something else';
      $('#audit').innerHTML = audit.recent.length
        ? `<table><caption class="sr-only">Recent activity</caption><thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What happened</th></tr></thead><tbody>${audit.recent.slice().reverse().map((r) => {
            const more = auditMore(r);
            return `<tr><td class="time">${esc(fmtTime(r.ts))}</td><td dir="auto">${esc(auditWho(r.actor))}</td><td>${esc(auditWhat(r))}${more ? `<span class="more" dir="auto">${esc(more)}</span>` : ''}</td></tr>`;
          }).join('')}</tbody></table>`
        : '<div class="empty">Nothing has been recorded yet.</div>';

      const size = (b) => (b.size >= 1048576 ? `${(b.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b.size / 1024))} KB`);
      $('#backups').innerHTML = backups.backups.length
        ? backups.backups.slice(0, 6).map((b) => `<div class="check-row"><span class="ico ok" aria-hidden="true">✓</span><div><b>${esc(fmtTime(b.modified))}</b> <span class="muted small">· ${esc(ago(b.modified))} · ${esc(size(b))}</span><div class="muted backup-name">${esc(b.name)}</div></div></div>`).join('')
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
      toast(`${results.map((r) => `${r.backend === 'local' ? 'On this computer' : r.backend === 'gdriveFolder' ? 'Google Drive folder' : 'Google Drive'}: ${r.ok ? (r.encrypted ? 'done, locked with your passphrase' : 'done') : String(r.error || 'it did not work').replace(/\.$/, '')}`).join(' · ')}.`, bad);
      if (!$('#view-security').hidden) await loadSecurity();
      if (!$('#view-settings').hidden) await loadBackupInfo();
      if (!$('#view-memory').hidden) await loadSetup();
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
      await Promise.all([loadBackupInfo(), loadTrash(), loadDevices()]);
    } catch (e) {
      $('#capture-list').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  function renderCapture() {
    $('#capture-list').innerHTML = Object.entries(CAPTURE_INFO).map(([k, [name, desc]]) => {
      const c = settings.capture[k] || { on: false, saved: 0, last: null };
      return `<div class="setting">
        <label class="switch"><input type="checkbox" role="switch" data-capture="${esc(k)}"${c.on ? ' checked' : ''} aria-describedby="cap-${esc(k)}"> <span>${esc(name)}</span> <span class="state">${c.on ? 'On' : 'Off'}</span></label>
        <p class="hint" id="cap-${esc(k)}">${esc(desc)}${c.saved ? ` Saved so far: ${esc(c.saved)}${c.last ? `, the last one ${esc(ago(c.last))}` : ''}.` : ''}</p>
      </div>`;
    }).join('');
  }

  async function setCapture(key, on, box) {
    box.disabled = true;
    try {
      await api('/settings', { method: 'PUT', body: { capture: { [key]: on } } });
      settings.capture[key].on = on;
      renderCapture();
      toast(`${CAPTURE_INFO[key][0]}: switched ${on ? 'on' : 'off'}.`);
      focusSoon($(`[data-capture="${CSS.escape(key)}"]`));
    } catch (e) { box.checked = !on; toast(e.message, true); } finally { box.disabled = false; }
  }

  async function syncNow(btn) {
    btn.disabled = true;
    $('#sync-status').textContent = 'Collecting… this can take a minute.';
    try {
      const r = await api('/sync/run', { method: 'POST' });
      $('#sync-status').textContent = r.ran.length ? `${r.note} Checked: ${r.ran.map((k) => CAPTURE_INFO[k]?.[0] || k).join(', ')}.` : r.note;
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
      <p>Copy in the cloud: <b>${cloud ? esc(cloud) : 'Off'}</b>. ${cloud ? '' : `Your data never leaves this computer. To keep a copy in Google Drive, ${docLink('docs/google-drive.md', 'follow the Google Drive guide')}.`}</p>
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

  /* ───────── your devices (device-sync.mjs) ───────── */
  let devices = null;
  async function loadDevices() {
    try { devices = await api('/devices'); } catch (e) { $('#devices-info').innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
    const d = devices;
    // A phone or tablet can read and sync, but the server refuses these (ownerOnly in server.mjs).
    const phone = Boolean(d.onPhone);
    $('#dv-phone-note').hidden = !phone;
    $$('#devices-form input').forEach((el) => { el.disabled = phone; });
    $('#devices-form button[type="submit"]').hidden = phone;
    for (const id of ['#dv-pass-form', '#pass-form', '#pair-phone-row']) $(id).hidden = phone;
    $('#dv-name').value = d.device.name;
    $('#dv-folder').value = d.folder || '';
    $('#dv-on').checked = d.enabled;
    const last = d.last
      ? `Last sync ${esc(ago(d.last.at))}: ${d.last.ok ? 'it went well' : 'there was a problem'}${d.last.added || d.last.changed || d.last.deleted ? ` (${plural(d.last.added, 'new memory', 'new memories')}, ${d.last.changed} changed, ${d.last.deleted} deleted)` : ''}.`
      : 'It has not synced yet.';
    const problems = (d.last?.problems || []).map((p) => `<li class="error-text">${esc(p)}</li>`).join('');
    const peers = d.peers.length
      ? `<ul class="devices-peers">${d.peers.map((p) => `<li><b dir="auto">${esc(p.name || p.id)}</b> <span class="muted small">· ${p.error ? esc(p.error) : `${plural(p.items ?? 0, 'memory', 'memories')}, saved ${esc(ago(p.exported_at))}`}${p.inFolder ? '' : ' · its file is no longer in the folder'}</span></li>`).join('')}</ul>`
      : '<p class="muted small">No other computers seen yet. Set up the same shared folder and passphrase on them.</p>';
    $('#devices-info').innerHTML = `<p><b>${d.enabled ? 'Syncing is on' : 'Syncing is off'}</b>${d.enabled ? `, every ${esc(d.intervalMinutes)} minutes while MemVault is open` : ''}. ${d.passphraseSet ? 'The sync passphrase is set.' : '<b>No sync passphrase yet.</b>'} ${last}</p>${problems ? `<ul class="plain">${problems}</ul>` : ''}<h4>Other computers</h4>${peers}`;
    $('#phones-list').innerHTML = d.phones.length
      ? `<ul class="plain">${d.phones.map((k) => `<li><span dir="auto"><b>${esc(k.name)}</b> <span class="muted small">· added ${esc(fmtDay(k.created_at))}${k.last_used_at ? `, last used ${esc(ago(k.last_used_at))}` : ''}</span></span>${phone ? '' : ` <button type="button" class="btn sm ghost" data-action="forget-phone" data-id="${esc(k.id)}" aria-label="Sign out: ${esc(k.name)}">Sign out</button>`}</li>`).join('')}</ul>`
      : '<p class="muted small">No phones or tablets are signed in.</p>';
  }

  async function saveDevices(ev) {
    ev.preventDefault();
    const err = $('#dv-error');
    try {
      await api('/devices', { method: 'PUT', body: { name: $('#dv-name').value.trim(), folder: $('#dv-folder').value.trim(), enabled: $('#dv-on').checked } });
      err.hidden = true;
      toast($('#dv-on').checked ? 'Saved. This computer will keep in step with your others.' : 'Saved. Syncing is off on this computer.');
      await loadDevices();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  }

  async function saveSyncPassphrase(ev) {
    ev.preventDefault();
    const err = $('#dp-error');
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    const a = $('#dp-1').value, b = $('#dp-2').value;
    if (a.length < 10) return fail('Use at least 10 characters.');
    if (a !== b) return fail('The two passphrases are not the same. Type the second one again.');
    try {
      await api('/devices/passphrase', { method: 'PUT', body: { passphrase: a, confirm: b } });
      err.hidden = true; $('#dp-1').value = ''; $('#dp-2').value = '';
      toast('Sync passphrase saved. Use the same one on your other computers, and write it down.');
      await loadDevices();
    } catch (e) { fail(e.message); }
  }

  async function devicesSync(btn) {
    btn.disabled = true;
    $('#devices-status').textContent = 'Syncing…';
    try {
      const r = await api('/devices/sync', { method: 'POST' });
      $('#devices-status').textContent = r.ok
        ? `Done: ${plural(r.added, 'new memory', 'new memories')}, ${r.changed} changed, ${r.deleted} deleted.${r.backup ? ' A backup was made first.' : ''}`
        : r.problems.join(' ');
      await loadDevices();
    } catch (e) { $('#devices-status').textContent = ''; toast(e.message, true); } finally { btn.disabled = false; }
  }

  async function pairPhone() {
    try {
      const r = await api('/devices/pair-code', { method: 'POST', body: { name: 'Phone or tablet' } });
      const where = devices?.addresses?.length
        ? `On the phone or tablet, open <b>${devices.addresses.map(esc).join('</b> or <b>')}</b>, choose “Use a pairing code” and type:`
        : 'On the phone or tablet, open this dashboard’s private address, choose “Use a pairing code” and type the code below. This dashboard has no private address yet: on this computer run <code>memvault devices hub --address https://…</code> first (see the guide).';
      const box = $('#pair-code');
      box.innerHTML = `<p>${where}</p><p class="big">${esc(r.code)}</p><p class="muted small">It works once, until ${esc(new Date(r.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}.</p>`;
      box.hidden = false;
      box.setAttribute('tabindex', '-1');
      focusSoon(box);
    } catch (e) { toast(e.message, true); }
  }

  async function forgetPhone(id) {
    const k = devices?.phones?.find((p) => p.id === id);
    if (!window.confirm(`Sign out ${k ? `“${k.name}”` : 'this phone or tablet'}? It will no longer be able to open this dashboard.`)) return;
    try { await api(`/devices/phones/${encodeURIComponent(id)}`, { method: 'DELETE' }); toast('Signed out.'); await loadDevices(); }
    catch (e) { toast(e.message, true); }
  }

  function renderProjects() {
    const list = settings.projects || [];
    $('#project-list').innerHTML = list.length
      ? `<ul class="plain">${list.map((p, i) => `<li><span dir="auto"><b>${esc(p.name)}</b>${p.match?.length ? ` <span class="muted">· ${esc(p.match.join(', '))}</span>` : ''}</span> <button type="button" class="btn sm ghost" data-action="remove-project" data-i="${i}" aria-label="Remove project: ${esc(p.name)}">Remove</button></li>`).join('')}</ul>`
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
    if (await saveProjects([...(settings.projects || []), { name, match: match.length ? match : [name.toLowerCase()], tags: '' }], `Added ${name}.`)) {
      $('#pj-name').value = ''; $('#pj-words').value = ''; focusSoon($('#pj-name'));
    }
  }

  async function loadTrash() {
    const { items } = await api('/trash');
    $('#trash-list').innerHTML = items.length
      ? `<ul class="plain">${items.map((i) => `<li><span dir="auto">${esc(friendly(i.title || 'Untitled'))} <span class="muted small">· deleted ${esc(ago(i.deleted_at))}</span></span> <button type="button" class="btn sm" data-action="put-back" data-id="${esc(i.id)}" aria-label="Put back: ${esc(friendly(i.title || 'Untitled'))}">Put back</button></li>`).join('')}</ul>`
      : '<p class="muted">Nothing has been deleted recently.</p>';
  }

  async function exportAll() {
    try {
      const token = getToken();
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
      toast(`Everything was deleted (${plural(r.deleted, 'memory', 'memories')}). A backup was made first${r.backup ? `: ${r.backup}` : ''}.`);
      mem.rows = [];
      await loadSettings();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  }

  /* ───────── one delegated click handler ───────── */
  const actions = {
    theme: toggleTheme,
    'text-smaller': () => { textLevel = setTextSize(textLevel - 1); toast(`Text size: ${SIZE_NAMES[textLevel]}.`); syncLookRadios(); },
    'text-larger': () => { textLevel = setTextSize(textLevel + 1); toast(`Text size: ${SIZE_NAMES[textLevel]}.`); syncLookRadios(); },
    help: () => { store.del('memvault-guide'); $('#guide').hidden = false; showView('memory', { focus: true }); },
    'setup-go': (el) => setupGo(el),
    'dismiss-guide': () => { store.set('memvault-guide', 'hidden'); $('#guide').hidden = true; focusSoon($('#diary-input')); },
    'connect-apps': openApps,
    'pick-app': (el) => pickApp(el.dataset.app),
    'copy-sample': () => copyText(SAMPLE, 'Copied. Paste it into your AI app.'),
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
        await loadAgents(); // first, so the message can use the new agents' names
        toast(r.installed.length ? `Added ${r.installed.map(agentName).join(', ')}.` : 'Those agents are already here.');
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
      try { const r = await api(`/agents/${encodeURIComponent(el.dataset.id)}/brief`); await copyText(r.briefing, 'Instructions copied. Paste them into any AI to make it this agent.'); }
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
      try { await api(`/agents/${encodeURIComponent(deletingId)}${$('#delete-purge').checked ? '?purge=1' : ''}`, { method: 'DELETE' }); dlg('dlg-delete').close(); toast('Agent deleted.'); await loadAgents(); focusSoon($('#h-agents')); }
      catch (e) { toast(e.message, true); }
    },
    'close-dialog': (el) => { const d = el.closest('dialog'); if (d) { if (d.hasAttribute('data-guard')) closeDialog(d); else d.close(); } },
    'copy-text': () => copyText($('#text-body').value, 'Copied.'),
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
        toast('Secret deleted.');
        focusSoon($('#secrets .secret') || $('#h-secrets'));
      } catch (e) { toast(e.message, true); }
      void row;
    },
    'copy-value': (el) => copyText(el.dataset.value, 'Copied.'),
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
    'devices-sync': devicesSync,
    'pair-phone': () => pairPhone(),
    'forget-phone': (el) => forgetPhone(el.dataset.id),
    'export-all': exportAll,
    'wipe-all': () => { $('#wipe-confirm').value = ''; $('#wipe-go').disabled = true; $('#wipe-error').hidden = true; dlg('dlg-wipe').showModal(); focusSoon($('#wipe-confirm')); },
    'wipe-go': wipeGo,
    'remove-project': (el) => saveProjects((settings.projects || []).filter((_, i) => i !== Number(el.dataset.i)), 'Project removed.').then(() => focusSoon($('#pj-name'))),
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
  $('#devices-form').addEventListener('submit', saveDevices);
  $('#dv-pass-form').addEventListener('submit', saveSyncPassphrase);
  // A phone or tablet: trade the one-time code for a key of its own, which stays on this device.
  $('#pair-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#pair-error');
    const code = $('#pair-input').value.trim();
    if (!code) { err.textContent = 'Type the pairing code first.'; err.hidden = false; return; }
    try {
      const r = await fetch('/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: $('#pair-name').value.trim() || undefined }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.key) throw new Error(data.error || 'That code did not work.');
      store.set(DEVICE_KEY, data.key);
      if (!store.get(DEVICE_KEY)) store.set(TOKEN_KEY, data.key, 'sessionStorage'); // storage blocked: signed in for this visit only
      err.hidden = true;
      $('#pair-input').value = '';
      dlg('dlg-connect').close();
      toast(`Signed in as “${data.name}”. This device stays signed in until you sign it out on your computer.`);
      showView($('.tab.is-active')?.dataset.view || 'memory');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
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
  if (!getToken()) openConnect();
  showView('memory');
})();
