(() => {
  const state = { sessionId: null, pendingFiles: [], streaming: false, reader: null, userScrolled: false, sessions: [], tab: 'workbench', history: [], datasets: [], crawlJobs: [], ragTables: [], selectedRagTable: 'documents', datasetMode: 'text' };
  const messages = document.querySelector('#messages-container');
  const input = document.querySelector('#text-input');
  const send = document.querySelector('#send-btn');
  const abort = document.querySelector('#abort-btn');
  const fileInput = document.querySelector('#file-input');
  const fileBar = document.querySelector('#file-preview-bar');
  const overlay = document.querySelector('#dropzone-overlay');
  const inputArea = document.querySelector('#input-area');
  const historyPanel = document.querySelector('#history-panel');
  const historyList = document.querySelector('#history-list');
  const historySearch = document.querySelector('#history-search');
  const sessionList = document.querySelector('#session-list');
  const conversationTab = document.querySelector('#conversation-tab');
  const workbenchTab = document.querySelector('#workbench-tab');
  const datasetsTab = document.querySelector('#datasets-tab');
  const datasetsPanel = document.querySelector('#datasets-panel');
  const datasetsList = document.querySelector('#datasets-list');
  const datasetsStats = document.querySelector('#datasets-stats');
  const datasetsError = document.querySelector('#datasets-error');
  const scanProgress = document.querySelector('#scan-progress');
  const urlInput = document.querySelector('#url-input');
  const scanUrlButton = document.querySelector('#scan-url-btn');
  const datasetFileInput = document.querySelector('#dataset-file-input');
  const attachDatasetButton = document.querySelector('#attach-dataset-btn');
  const ragTableTabs = document.querySelector('#rag-table-tabs');
  const addTextMode = document.querySelector('#add-text-mode');
  const addFileMode = document.querySelector('#add-file-mode');
  const addUrlMode = document.querySelector('#add-url-mode');
  const addTextForm = document.querySelector('#add-text-form');
  const addFileForm = document.querySelector('#add-file-form');
  const addUrlForm = document.querySelector('#add-url-form');
  const addTextButton = document.querySelector('#add-text-btn');
  const textContentInput = document.querySelector('#text-content-input');
  const textLabelInput = document.querySelector('#text-label-input');
  const datasetFileName = document.querySelector('#dataset-file-name');
  const deleteTableButton = document.querySelector('#delete-table-btn');
  const crawlPagesSelect = document.querySelector('#crawl-pages-select');
  const crawlDepthSelect = document.querySelector('#crawl-depth-select');
  const main = document.querySelector('#main');
  const debugPanel = document.querySelector('#debug-panel');
  const debugBody = document.querySelector('#debug-body');
  const sidebar = document.querySelector('#sidebar');
  const sidebarToggle = document.querySelector('#sidebar-toggle');
  const sidebarRestore = document.querySelector('#sidebar-restore');

  function setSidebarCollapsed(collapsed) {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    sidebarToggle.innerHTML = collapsed ? '&#8250;' : '&#8249;';
    sidebarToggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    sidebarRestore.classList.toggle('hidden', !collapsed);
    localStorage.setItem('btw-sidebar-collapsed', String(collapsed));
  }

  function setSidebarWidth(width) {
    const nextWidth = Math.max(96, Math.min(Math.floor(window.innerWidth * 0.8), width));
    sidebar.style.width = `${nextWidth}px`;
  }

  function setupSidebar() {
    const resizer = document.createElement('div');
    resizer.className = 'sidebar-resizer';
    sidebar.appendChild(resizer);
    let dragging = false;
    resizer.addEventListener('pointerdown', event => {
      if (document.body.classList.contains('sidebar-collapsed')) return;
      dragging = true;
      resizer.classList.add('is-dragging');
      document.body.classList.add('sidebar-dragging');
      resizer.setPointerCapture(event.pointerId);
    });
    resizer.addEventListener('pointermove', event => {
      if (!dragging) return;
      if (event.clientX < 96) {
        dragging = false;
        resizer.classList.remove('is-dragging');
        document.body.classList.remove('sidebar-dragging');
        setSidebarCollapsed(true);
        return;
      }
      setSidebarWidth(event.clientX);
    });
    resizer.addEventListener('pointerup', () => {
      dragging = false;
      resizer.classList.remove('is-dragging');
      document.body.classList.remove('sidebar-dragging');
    });
    resizer.addEventListener('dblclick', () => setSidebarWidth(256));
    sidebarToggle.addEventListener('click', () => setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed')));
    sidebarRestore.addEventListener('click', () => setSidebarCollapsed(false));
    setSidebarCollapsed(localStorage.getItem('btw-sidebar-collapsed') === 'true');
  }

  async function request(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Request failed');
    return response;
  }

  function formatDate(timestamp) {
    return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function showEmptyState() {
    messages.innerHTML = '<div id="empty-state" class="flex-1 flex items-center justify-center"><p class="text-muted text-sm">Workbench ready. Ask for a detailed answer, paste code, or attach a file.</p></div>';
  }

  function switchTab(tab) {
    state.tab = tab;
    const conversation = tab === 'conversation';
    messages.classList.toggle('hidden', tab !== 'workbench');
    historyPanel.classList.toggle('hidden', !conversation);
    datasetsPanel.classList.toggle('hidden', tab !== 'datasets');
    inputArea.classList.toggle('hidden', conversation);
    inputArea.classList.toggle('hidden', tab === 'datasets');
    conversationTab.classList.toggle('bg-white/10', conversation);
    conversationTab.classList.toggle('text-white', conversation);
    workbenchTab.classList.toggle('bg-white/10', !conversation);
    workbenchTab.classList.toggle('text-white', !conversation);
    datasetsTab.classList.toggle('bg-white/10', tab === 'datasets');
    datasetsTab.classList.toggle('text-white', tab === 'datasets');
  }

  function renderDatasetCard(source) {
    const card = document.createElement('div');
    card.className = 'source-card group bg-white/5 border border-border rounded-xl px-4 py-3 flex items-start justify-between gap-3 transition-all';
    const badge = source.type === 'url' ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' : 'bg-purple-500/10 text-purple-400 border-purple-500/20';
    card.innerHTML = `<div class="source-info flex flex-col gap-1 min-w-0"><div class="source-label flex items-center gap-2"><span class="type-badge text-[10px] uppercase tracking-widest px-1.5 py-0.5 rounded border ${badge}">${escapeHtml(source.type)}</span><span class="source-name text-sm font-medium truncate">${escapeHtml(source.label || source.source)}</span></div><div class="source-meta text-xs text-muted">${escapeHtml(source.table || 'documents')} · ${source.chunks || 0} chunks · added ${formatDate(source.addedAt)}</div><div class="source-url text-xs text-muted truncate" title="${escapeHtml(source.source)}">${escapeHtml(source.source)}</div></div><div class="source-actions flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity"><button class="view-btn text-xs text-muted hover:text-white" title="Open source">&#8599;</button><button class="delete-btn text-xs text-muted hover:text-red-400" title="Delete source">&times;</button></div>`;
    card.querySelector('.view-btn').classList.toggle('hidden', source.type !== 'url');
    card.querySelector('.view-btn').addEventListener('click', () => window.open(source.source, '_blank', 'noopener'));
    const deleteButton = card.querySelector('.delete-btn');
    let confirmTimer;
    deleteButton.addEventListener('click', async () => {
      if (deleteButton.textContent !== 'Delete?') {
        deleteButton.textContent = 'Delete?';
        confirmTimer = setTimeout(() => { deleteButton.textContent = '×'; }, 2000);
        return;
      }
      clearTimeout(confirmTimer);
      await request(`/api/rag/sources/${source.id}`, { method: 'DELETE' });
      card.classList.add('opacity-0', 'scale-95');
      setTimeout(() => { card.remove(); refreshDatasets(); }, 200);
    });
    return card;
  }

  function renderDatasets() {
    datasetsList.innerHTML = '';
    const chunks = state.datasets.reduce((total, source) => total + (source.chunks || 0), 0);
    const tableSources = state.datasets.filter(source => source.table === state.selectedRagTable);
    const tableChunks = tableSources.reduce((total, source) => total + (source.chunks || 0), 0);
    datasetsStats.textContent = `${tableSources.length} sources · ${tableChunks} chunks`;
    if (!tableSources.length) {
      datasetsList.innerHTML = '<div class="empty-datasets flex flex-col items-center justify-center py-16 gap-3"><span class="text-4xl">&#128452;</span><p class="text-muted text-sm">No sources indexed yet.</p><p class="text-xs text-muted">Paste a URL above or upload a file to get started.</p></div>';
      return;
    }
    tableSources.forEach(source => datasetsList.appendChild(renderDatasetCard(source)));
  }

  async function refreshDatasets() {
    datasetsList.innerHTML = '<div class="h-16 rounded-xl bg-white/5 animate-pulse"></div><div class="h-16 rounded-xl bg-white/5 animate-pulse"></div><div class="h-16 rounded-xl bg-white/5 animate-pulse"></div>';
    state.datasets = await (await request('/api/rag/sources')).json();
    renderDatasets();
  }

  function renderCrawlProgress() {
    const job = state.crawlJobs.find(item => item.status === 'running' || item.status === 'queued') || state.crawlJobs[0];
    if (!job) { scanProgress.classList.add('hidden'); return; }
    scanProgress.classList.remove('hidden');
    const status = job.status === 'completed' ? 'Completed' : job.status === 'failed' ? `Failed: ${job.error || 'unknown error'}` : (job.current || 'Preparing scan');
    scanProgress.textContent = `${status} · ${job.fetchedPages || 0} fetched · ${job.skippedPages || 0} skipped · ${job.fetchedChars || 0} chars · ${job.indexedChunks || 0} chunks`;
  }

  async function refreshCrawlJobs() {
    state.crawlJobs = await (await request('/api/rag/crawl-jobs')).json();
    renderCrawlProgress();
  }

  async function refreshRagTables() {
    const tables = await (await request('/api/rag/tables')).json();
    state.ragTables = tables;
    if (!tables.includes(state.selectedRagTable)) state.selectedRagTable = tables.includes('documents') ? 'documents' : tables[0] || 'documents';
    ragTableTabs.innerHTML = tables.map(table => `<button data-table="${escapeHtml(table)}" class="rag-table-tab whitespace-nowrap rounded-lg px-3 py-2 text-sm ${table === state.selectedRagTable ? 'bg-white/10 text-white' : 'text-muted hover:text-white hover:bg-white/5'}">${escapeHtml(table)}</button>`).join('') + '<button id="new-rag-table-tab" class="whitespace-nowrap rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted hover:text-white">+ New table</button>';
    ragTableTabs.querySelectorAll('[data-table]').forEach(button => button.addEventListener('click', () => { state.selectedRagTable = button.dataset.table; refreshRagTables(); renderDatasets(); }));
    document.querySelector('#new-rag-table-tab').addEventListener('click', createNewRagTable);
  }

  function selectedRagTable() {
    return state.selectedRagTable;
  }

  async function createNewRagTable() {
    const name = window.prompt('New table name');
    if (!name) return;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) { datasetsError.textContent = 'Use a table name starting with a letter; letters, numbers, _ and - are allowed.'; datasetsError.classList.remove('hidden'); return; }
    datasetsError.classList.add('hidden');
    try {
      await request('/api/rag/tables', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: name }) });
      state.selectedRagTable = name;
      await refreshRagTables();
      renderDatasets();
    } catch (error) {
      datasetsError.textContent = error.message;
      datasetsError.classList.remove('hidden');
    }
  }

  async function deleteSelectedTable() {
    const table = state.selectedRagTable;
    if (table === 'documents') {
      datasetsError.textContent = 'The default documents table cannot be deleted.';
      datasetsError.classList.remove('hidden');
      return;
    }
    if (deleteTableButton.dataset.confirm !== table) {
      deleteTableButton.dataset.confirm = table;
      deleteTableButton.textContent = 'Delete?';
      setTimeout(() => {
        if (deleteTableButton.dataset.confirm === table) {
          deleteTableButton.dataset.confirm = '';
          deleteTableButton.textContent = 'Delete table';
        }
      }, 2000);
      return;
    }
    deleteTableButton.disabled = true;
    try {
      await request(`/api/rag/tables/${encodeURIComponent(table)}`, { method: 'DELETE' });
      deleteTableButton.dataset.confirm = '';
      deleteTableButton.textContent = 'Delete table';
      await refreshDatasets();
      await refreshRagTables();
    } catch (error) {
      datasetsError.textContent = error.message;
      datasetsError.classList.remove('hidden');
    } finally {
      deleteTableButton.disabled = false;
    }
  }

  async function scanUrl() {
    const url = urlInput.value.trim();
    datasetsError.classList.add('hidden');
    if (!/^https?:\/\//i.test(url)) { datasetsError.textContent = 'Enter a valid http(s) URL.'; datasetsError.classList.remove('hidden'); return; }
    scanUrlButton.disabled = true; scanUrlButton.textContent = 'Scanning...';
    scanProgress.classList.remove('hidden');
    scanProgress.textContent = 'Preparing scan...';
    try {
      const table = selectedRagTable();
      const maxPages = Number(crawlPagesSelect.value);
      const maxDepth = Number(crawlDepthSelect.value);
      const response = await request('/api/rag/scan-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, maxPages, maxDepth, table }) });
      const job = await response.json();
      state.crawlJobs.unshift(job);
      renderCrawlProgress();
      urlInput.value = '';
      await refreshDatasets();
      await refreshRagTables();
    }
    catch (error) { datasetsError.textContent = error.message; datasetsError.classList.remove('hidden'); }
    finally { scanUrlButton.disabled = false; scanUrlButton.textContent = 'Scan'; }
  }

  function parseMeta(meta) {
    if (!meta) return {};
    const parsed = { ...meta };
    if (typeof parsed.rawResult === 'string') {
      try { parsed.rawResult = JSON.parse(parsed.rawResult); } catch (_) { parsed.rawResult = { raw: parsed.rawResult }; }
    }
    return parsed;
  }

  function durationLabel(meta) {
    if (!meta?.durationMs) return '< 1s';
    return meta.durationMs < 1000 ? '< 1s' : `${(meta.durationMs / 1000).toFixed(1)}s`;
  }

  function openDebug(meta) {
    const details = parseMeta(meta);
    const plugins = Array.isArray(details.plugins) ? details.plugins : [];
    const raw = JSON.stringify(details.rawResult || {}, null, 2);
    const routing = plugins.map((plugin, index) => {
      const name = Array.isArray(plugin) ? String(plugin[0] || 'RAG') : String(plugin);
      const sources = Array.isArray(plugin) && Array.isArray(plugin[1]) ? `<details class="w-full text-xs text-muted"><summary class="cursor-pointer">RAG Sources (${plugin[1].length})</summary><pre class="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap">${escapeHtml(JSON.stringify(plugin[1], null, 2))}</pre></details>` : '';
      return `<span class="plugin-badge bg-accent/10 border border-accent/30 text-accent text-xs px-2 py-0.5 rounded-full" data-plugin-index="${index}">${escapeHtml(name)}</span>${sources}`;
    }).join('') || '<span class="text-sm text-muted">No plugins reported</span>';
    debugBody.innerHTML = `<section><div class="text-xs text-muted uppercase tracking-widest mb-2">YOU</div><div class="text-muted text-sm leading-relaxed">${escapeHtml(details.query || '')}</div></section><section><div class="text-xs text-muted uppercase tracking-widest mb-2">PERFORMANCE</div><div class="flex gap-2"><span class="bg-white/5 border border-border rounded-lg px-3 py-2 text-xs">&#9201; ${durationLabel(details)} generated</span><span class="bg-white/5 border border-border rounded-lg px-3 py-2 text-xs">~${details.tokenEstimate || 0} tokens</span></div></section><section><div class="text-xs text-muted uppercase tracking-widest mb-2">ROUTING</div><div class="flex flex-wrap gap-2">${routing}</div></section><section><div class="text-xs text-muted uppercase tracking-widest mb-2">RAW INTERPRETER OUTPUT</div><div class="relative"><button id="debug-copy" class="absolute right-2 top-2 z-10 copy-btn text-xs">Copy</button><pre class="max-h-[400px] overflow-y-auto bg-[#111] border border-border rounded-lg p-3"><code id="debug-json" class="language-json"></code></pre></div></section>`;
    const code = document.querySelector('#debug-json');
    code.textContent = raw;
    hljs.highlightElement(code);
    document.querySelector('#debug-copy').addEventListener('click', async event => {
      await navigator.clipboard.writeText(raw);
      event.currentTarget.textContent = 'Copied';
      setTimeout(() => { event.currentTarget.textContent = 'Copy'; }, 1200);
    });
    debugPanel.classList.remove('translate-x-full');
    debugPanel.classList.add('translate-x-0');
    if (window.innerWidth >= 900) main.classList.add('mr-[420px]');
  }

  function closeDebug() {
    debugPanel.classList.add('translate-x-full');
    debugPanel.classList.remove('translate-x-0');
    main.classList.remove('mr-[420px]');
  }

  function setSendMode(generating) {
    send.disabled = false;
    send.title = generating ? 'Stop generation' : 'Send message';
    send.innerHTML = generating
      ? '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
      : '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 7-7 7 7M12 19V5"/></svg>';
  }

  async function stopGeneration() {
    if (!state.streaming) return;
    await fetch(`/api/abort/${state.sessionId}`, { method: 'POST' }).catch(() => {});
    await state.reader?.cancel();
  }

  function addActions(wrapper, meta, messageIndex, versions = []) {
    wrapper.dataset.meta = JSON.stringify(meta || {});
    wrapper.classList.add('group');
    const actions = document.createElement('div');
    actions.className = 'message-actions flex items-center gap-3 mt-3 opacity-0 group-hover:opacity-100 transition-opacity duration-150 max-w-[800px] mx-auto';
    const versionCount = versions.length || meta?.versionCount || 1;
    const versionIndex = Number.isInteger(meta?.versionIndex) ? meta.versionIndex : versionCount - 1;
    actions.innerHTML = `<button title="Copy" data-action="copy">&#x29C9;</button><button title="Regenerate" data-action="regenerate">&#8635;</button><span title="Generated duration" class="duration-badge text-xs text-muted flex items-center gap-1">&#9201; ${durationLabel(meta)}</span><span class="flex items-center gap-1 text-xs text-muted"><button title="Previous response" data-action="previous" ${versionIndex === 0 ? 'disabled' : ''}>&#8592;</button><span>&lt;${versionIndex + 1}/${versionCount}&gt;</span><button title="Next response" data-action="next" ${versionIndex >= versionCount - 1 ? 'disabled' : ''}>&#8594;</button></span><button title="View details" data-action="debug">{ }</button>`;
    actions.querySelector('[data-action="copy"]').addEventListener('click', () => navigator.clipboard.writeText(wrapper.querySelector('.assistant-content').innerText));
    actions.querySelector('[data-action="regenerate"]').addEventListener('click', () => regenerate(wrapper));
    actions.querySelector('[data-action="previous"]').addEventListener('click', () => navigateVersion(wrapper, -1));
    actions.querySelector('[data-action="next"]').addEventListener('click', () => navigateVersion(wrapper, 1));
    actions.querySelector('[data-action="debug"]').addEventListener('click', () => openDebug(JSON.parse(wrapper.dataset.meta || '{}')));
    wrapper.appendChild(actions);
  }

  function finalizeAssistant(bubble, meta, messageIndex, versions = []) {
    const wrapper = bubble.closest('.message');
    wrapper.querySelector('.message-actions')?.remove();
    addActions(wrapper, parseMeta(meta), messageIndex, versions);
  }

  async function navigateVersion(wrapper, offset) {
    const assistantIndex = Number(wrapper.dataset.index);
    const record = state.history[assistantIndex];
    if (!record?.versions?.length) return;
    const current = Number.isInteger(record.versionIndex) ? record.versionIndex : record.versions.length - 1;
    const nextIndex = current + offset;
    if (!record.versions[nextIndex]) return;
    record.versionIndex = nextIndex;
    record.content = record.versions[nextIndex].content;
    record.meta = record.versions[nextIndex].meta;
    const bubble = wrapper.querySelector('.assistant-content');
    renderAssistant(bubble, record.content);
    finalizeAssistant(bubble, record.meta, assistantIndex, record.versions);
    request(`/api/session/${state.sessionId}/version`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assistantIndex, versionIndex: nextIndex }) }).catch(() => {});
  }

  function appendMessage(role, content, meta, index, versions = []) {
    if (role === 'assistant') {
      const bubble = addMessage('assistant', '', '', { index });
      renderAssistant(bubble, content);
      finalizeAssistant(bubble, meta, index, versions);
      return;
    }
    addMessage('user', `<p>${escapeHtml(content || '[Attached files]')}</p>`, '', { index });
  }

  function renderSessionEntries(container, sessions, compact = false) {
    container.innerHTML = '';
    sessions.forEach(session => {
      const entry = document.createElement('div');
      entry.className = compact
        ? `session-item group flex items-center px-3 py-2 rounded-lg cursor-pointer text-sm truncate transition-colors ${session.id === state.sessionId ? 'bg-white/10 text-white' : 'text-muted hover:text-white hover:bg-white/5'}`
        : 'history-entry group flex items-start justify-between gap-2 px-3 py-3 rounded-xl hover:bg-white/5 cursor-pointer transition-colors border border-transparent hover:border-border';
      entry.innerHTML = compact
        ? `<span class="truncate flex-1">${escapeHtml(session.title || 'New conversation')}</span><button class="entry-delete opacity-0 group-hover:opacity-100 transition-opacity text-muted hover:text-red-400 text-xs flex-shrink-0" title="Delete conversation">&#128465;</button>`
        : `<div class="min-w-0"><div class="entry-title truncate text-sm text-white">${escapeHtml(session.title || 'New conversation')}</div><div class="entry-meta mt-1 text-xs text-muted">${formatDate(session.updatedAt)} · ${session.messageCount} messages</div></div><button class="entry-delete opacity-0 group-hover:opacity-100 transition-opacity text-muted hover:text-red-400 text-xs flex-shrink-0" title="Delete conversation">&#128465;</button>`;
      entry.addEventListener('click', () => loadSession(session.id));
      entry.querySelector('.entry-delete')?.addEventListener('click', event => {
        event.stopPropagation();
        deleteSession(session.id);
      });
      container.appendChild(entry);
    });
  }

  function renderSessions() {
    const search = historySearch.value.trim().toLowerCase();
    renderSessionEntries(sessionList, state.sessions.slice(0, 5), true);
    renderSessionEntries(historyList, state.sessions.filter(session => (session.title || '').toLowerCase().includes(search)));
  }

  async function refreshSessions() {
    state.sessions = await (await request('/api/sessions')).json();
    renderSessions();
  }

  async function loadSession(sessionId) {
    const session = await (await request(`/api/session/${sessionId}`)).json();
    state.sessionId = session.id;
    showEmptyState();
    state.history = session.history || [];
    session.history.forEach((entry, index) => {
      const meta = entry.role === 'assistant' ? { ...(entry.meta || {}), versionIndex: entry.versionIndex ?? entry.meta?.versionIndex, versionCount: entry.versions?.length || entry.meta?.versionCount || 1 } : entry.meta;
      appendMessage(entry.role, entry.content, meta, index, entry.versions || []);
    });
    switchTab('workbench');
    await refreshSessions();
    messages.lastElementChild?.scrollIntoView({ block: 'end' });
    input.focus();
  }

  async function newChat() {
    const session = await (await request('/api/session/new', { method: 'POST' })).json();
    state.sessionId = session.sessionId;
    state.history = [];
    state.pendingFiles = [];
    input.innerHTML = '';
    renderFiles();
    showEmptyState();
    switchTab('workbench');
    await refreshSessions();
    input.focus();
  }

  async function deleteSession(sessionId) {
    await request(`/api/session/${sessionId}`, { method: 'DELETE' });
    if (sessionId === state.sessionId) await newChat();
    else await refreshSessions();
  }

  function addMessage(role, html, extraClass = '', options = {}) {
    document.querySelector('#empty-state')?.remove();
    const element = document.createElement('article');
    element.className = role === 'user'
      ? `message user flex justify-end ${extraClass}`
      : `message ${role} w-full ${extraClass}`;
    const contentClass = role === 'assistant' ? 'assistant-content max-w-[800px] mx-auto text-sm leading-relaxed' : 'message-body';
    const bodyClass = role === 'user' ? 'max-w-[70%] bg-white/5 rounded-2xl rounded-br-sm px-4 py-3 text-sm' : contentClass;
    element.innerHTML = `<div class="${bodyClass}">${html}</div>`;
    if (Number.isInteger(options.index)) element.dataset.index = options.index;
    messages.appendChild(element);
    element.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return element.firstElementChild;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function sanitizeBubble(bubble) {
    bubble.querySelectorAll('script,style,iframe,object,embed').forEach(node => node.remove());
    bubble.querySelectorAll('*').forEach(node => {
      [...node.attributes].forEach(attribute => {
        if (/^on/i.test(attribute.name) || (attribute.name === 'href' && /^javascript:/i.test(attribute.value))) node.removeAttribute(attribute.name);
      });
    });
  }

  function decorateCode(body) {
    body.querySelectorAll('pre code').forEach(code => {
      const pre = code.parentElement;
      if (pre.previousElementSibling?.classList.contains('code-header')) return;
      const language = [...code.classList].find(name => name.startsWith('language-'))?.slice(9) || 'code';
      const tools = document.createElement('div');
      tools.className = 'code-header';
      tools.innerHTML = `<span>${escapeHtml(language)}</span><button class="copy-btn">Copy</button>`;
      tools.querySelector('button').addEventListener('click', async () => {
        await navigator.clipboard.writeText(code.textContent);
        tools.querySelector('button').textContent = 'Copied';
        setTimeout(() => { tools.querySelector('button').textContent = 'Copy'; }, 1200);
      });
      pre.parentNode.insertBefore(tools, pre);
    });
  }

  function renderAssistant(bubble, accumulatedText) {
    bubble.innerHTML = marked.parse(accumulatedText);
    hljs.highlightAll();
    sanitizeBubble(bubble);
    bubble.querySelectorAll('pre code').forEach(function(block) {
      hljs.highlightElement(block);
    });
    decorateCode(bubble);
    if (!state.userScrolled) messages.lastElementChild?.scrollIntoView({ block: 'end' });
  }

  function renderFiles() {
    fileBar.innerHTML = state.pendingFiles.map(file => `<span class="file-chip inline-flex items-center gap-2 bg-white/5 border border-border rounded-lg px-3 py-1.5 text-xs" data-id="${file.fileId}">&#128196; ${escapeHtml(file.name)} <button title="Remove attachment">&times;</button></span>`).join('');
    fileBar.querySelectorAll('button').forEach(button => button.addEventListener('click', () => {
      const chip = button.closest('.file-chip');
      state.pendingFiles = state.pendingFiles.filter(file => file.fileId !== chip.dataset.id);
      renderFiles();
    }));
  }

  async function uploadFile(file) {
    const max = 20 * 1024 * 1024;
    if (file.size > max) throw new Error(`${file.name} is larger than 20 MB`);
    const form = new FormData();
    form.append('file', file);
    form.append('sessionId', state.sessionId);
    const data = await (await request('/api/upload', { method: 'POST', body: form })).json();
    state.pendingFiles.push(data);
    renderFiles();
  }

  async function uploadFiles(files) {
    for (const file of files) {
      try { await uploadFile(file); } catch (error) { addMessage('error', escapeHtml(error.message)); }
    }
  }

  async function uploadDataset(file) {
    const form = new FormData();
    form.append('file', file);
    form.append('sessionId', state.sessionId);
    form.append('context', 'dataset');
    try { form.append('table', selectedRagTable()); }
    catch (error) { datasetsError.textContent = error.message; datasetsError.classList.remove('hidden'); return; }
    attachDatasetButton.disabled = true;
    attachDatasetButton.textContent = 'Indexing...';
    datasetsError.classList.add('hidden');
    try { await request('/api/upload', { method: 'POST', body: form }); await refreshDatasets(); await refreshRagTables(); }
    catch (error) { datasetsError.textContent = error.message; datasetsError.classList.remove('hidden'); }
    finally { attachDatasetButton.disabled = false; attachDatasetButton.textContent = 'Upload File'; datasetFileInput.value = ''; }
  }

  async function addTextToTable() {
    datasetsError.classList.add('hidden');
    try {
      await request('/api/rag/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: selectedRagTable(), text: textContentInput.value, label: textLabelInput.value.trim() || 'Text note' }) });
      textContentInput.value = '';
      textLabelInput.value = '';
      await refreshDatasets();
    } catch (error) { datasetsError.textContent = error.message; datasetsError.classList.remove('hidden'); }
  }

  function setDatasetMode(mode) {
    state.datasetMode = mode;
    addTextForm.classList.toggle('hidden', mode !== 'text');
    addFileForm.classList.toggle('hidden', mode !== 'file');
    addUrlForm.classList.toggle('hidden', mode !== 'url');
    [addTextMode, addFileMode, addUrlMode].forEach(button => {
      const active = button.dataset.mode === mode;
      button.classList.toggle('bg-accent', active);
      button.classList.toggle('text-white', active);
      button.classList.toggle('border', !active);
      button.classList.toggle('border-border', !active);
      button.classList.toggle('text-muted', !active);
    });
  }

  async function regenerate(wrapper) {
    const assistantIndex = Number(wrapper.dataset.index);
    const userIndex = assistantIndex - 1;
    const userMessage = state.history[userIndex];
    if (!userMessage || userMessage.role !== 'user' || state.streaming) return;
    await sendMessage(userMessage.content, userMessage.files || [], { skipHistory: true, replaceAssistant: { wrapper, assistantIndex } });
  }

  async function sendMessage(messageOverride = null, fileIdsOverride = null, options = {}) {
    if (state.streaming) return;
    const text = messageOverride === null ? input.innerText.trim() : String(messageOverride).trim();
    const files = fileIdsOverride === null
      ? state.pendingFiles.slice()
      : fileIdsOverride.map(fileId => ({ fileId, name: fileId }));
    if (!text && !files.length) return;
    input.innerHTML = '';
    if (fileIdsOverride === null) {
      state.pendingFiles = [];
      renderFiles();
    }
    const userIndex = state.history.length;
    if (!options.skipHistory) state.history.push({ role: 'user', content: text, files: files.map(file => file.fileId) });
    const assistantIndex = options.replaceAssistant?.assistantIndex ?? state.history.length;
    if (!options.replaceAssistant) {
      addMessage('user', `<p>${escapeHtml(text || '[Attached files]')}</p>${files.map(file => `<span class="inline-flex items-center gap-2 bg-white/5 border border-border rounded-lg px-3 py-1.5 text-xs">&#128196; ${escapeHtml(file.name)}</span>`).join(' ')}`, '', { index: userIndex });
    }
    const assistant = options.replaceAssistant
      ? options.replaceAssistant.wrapper.querySelector('.assistant-content')
      : addMessage('assistant', '<span class="typing"><i></i><i></i><i></i></span>', '', { index: assistantIndex });
    if (options.replaceAssistant) {
      options.replaceAssistant.wrapper.querySelector('.message-actions')?.remove();
      assistant.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    }
    state.streaming = true; setSendMode(true); abort.classList.add('hidden');
    try {
      const response = await request('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: state.sessionId, message: text, fileIds: files.map(file => file.fileId), regenerate: Boolean(options.replaceAssistant), assistantIndex }) });
      state.reader = response.body.getReader();
      const decoder = new TextDecoder(); let buffer = ''; let full = '';
      while (state.reader) {
        const chunk = await state.reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const events = buffer.split('\n\n'); buffer = events.pop();
        for (const event of events) {
          const line = event.split('\n').find(item => item.startsWith('data: '));
          if (!line) continue;
          const payload = JSON.parse(line.slice(6));
          if (payload.type === 'token') { full += payload.content; renderAssistant(assistant, full); }
          if (payload.type === 'done') {
            full = payload.fullResponse || full;
            renderAssistant(assistant, full);
            const meta = parseMeta(payload.meta);
            if (options.replaceAssistant) {
              const record = state.history[assistantIndex];
              record.versions = Array.isArray(record.versions) ? record.versions : [{ content: record.content, meta: record.meta || {} }];
              record.versions.push({ content: full, meta });
              record.versionIndex = record.versions.length - 1;
              record.content = full;
              record.meta = meta;
              finalizeAssistant(assistant, meta, assistantIndex, record.versions);
            } else {
              state.history.push({ role: 'assistant', content: full, meta, versions: [{ content: full, meta }], versionIndex: 0 });
              finalizeAssistant(assistant, meta, assistantIndex, state.history[assistantIndex].versions);
            }
            await refreshSessions();
          }
          if (payload.type === 'error') throw new Error(payload.message);
        }
      }
    } catch (error) {
      if (options.replaceAssistant) {
        const record = state.history[assistantIndex];
        renderAssistant(assistant, record.content);
        finalizeAssistant(assistant, record.meta, assistantIndex, record.versions || []);
      } else {
        assistant?.closest('.message')?.remove();
      }
      addMessage('error', escapeHtml(error.message === 'Failed to fetch' ? 'Connection lost. Try again.' : error.message));
    }
    finally { state.reader = null; state.streaming = false; setSendMode(false); abort.classList.add('hidden'); input.focus(); }
  }

  async function init() {
    state.sessionId = (await (await request('/api/session/new', { method: 'POST' })).json()).sessionId;
    await refreshSessions();
    await refreshDatasets();
    await refreshRagTables();
    await refreshCrawlJobs();
    switchTab('workbench');
  }

  document.querySelector('#attach-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', event => uploadFiles(event.target.files));
  send.addEventListener('click', () => state.streaming ? stopGeneration() : sendMessage());
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); } });
  input.addEventListener('paste', event => { event.preventDefault(); const image = [...event.clipboardData.items].find(item => item.type.startsWith('image/')); if (image) uploadFiles([image.getAsFile()]); else document.execCommand('insertText', false, event.clipboardData.getData('text/plain')); });
  abort.addEventListener('click', stopGeneration);
  document.querySelector('#new-chat-btn').addEventListener('click', () => newChat().catch(error => addMessage('error', escapeHtml(error.message))));
  conversationTab.addEventListener('click', () => { switchTab('conversation'); refreshSessions().catch(error => addMessage('error', escapeHtml(error.message))); });
  workbenchTab.addEventListener('click', () => switchTab('workbench'));
  datasetsTab.addEventListener('click', () => { switchTab('datasets'); Promise.all([refreshDatasets(), refreshRagTables()]).catch(error => { datasetsError.textContent = error.message; datasetsError.classList.remove('hidden'); }); });
  deleteTableButton.addEventListener('click', deleteSelectedTable);
  addTextMode.dataset.mode = 'text';
  addFileMode.dataset.mode = 'file';
  addUrlMode.dataset.mode = 'url';
  addTextMode.addEventListener('click', () => setDatasetMode('text'));
  addFileMode.addEventListener('click', () => setDatasetMode('file'));
  addUrlMode.addEventListener('click', () => setDatasetMode('url'));
  addTextButton.addEventListener('click', addTextToTable);
  scanUrlButton.addEventListener('click', scanUrl);
  attachDatasetButton.addEventListener('click', () => datasetFileInput.click());
  datasetFileInput.addEventListener('change', event => { if (event.target.files[0]) { datasetFileName.textContent = event.target.files[0].name; uploadDataset(event.target.files[0]); } });
  setInterval(() => refreshCrawlJobs().catch(() => {}), 1500);
  historySearch.addEventListener('input', renderSessions);
  document.querySelector('#debug-close').addEventListener('click', closeDebug);
  messages.addEventListener('click', event => {
    if (!event.target.closest('.message-actions')) closeDebug();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDebug(); });
  messages.addEventListener('scroll', () => { state.userScrolled = messages.scrollTop + messages.clientHeight < messages.scrollHeight - 80; });
  document.addEventListener('dragover', event => { event.preventDefault(); overlay.classList.replace('hidden', 'flex'); });
  overlay.addEventListener('dragleave', () => overlay.classList.replace('flex', 'hidden'));
  overlay.addEventListener('drop', event => { event.preventDefault(); overlay.classList.replace('flex', 'hidden'); uploadFiles(event.dataTransfer.files); });
  init().catch(error => addMessage('error', escapeHtml(error.message)));
  setupSidebar();
  setDatasetMode('text');
})();
