(() => {
  if (window.__threadsUiInitialized) return;
  window.__threadsUiInitialized = true;

  let isCreatingThread = false;

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function truncate(s, max) {
    const t = String(s ?? '').trim();
    if (!t) return '';
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  }

  function formatDate(dateString) {
    if (!dateString) return 'No messages yet';
    
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return 'Today';
    } else if (diffDays === 1) {
      return 'Yesterday';
    } else if (diffDays < 7) {
      return date.toLocaleDateString('en-US', { weekday: 'long' });
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  }

  function getDeleteButtonSvg() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="3 6 5 6 21 6"></polyline>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      <line x1="10" y1="11" x2="10" y2="17"></line>
      <line x1="14" y1="11" x2="14" y2="17"></line>
    </svg>`;
  }

  async function fetchJson(url, options) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...options,
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt || `${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  function getActiveThreadIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('thread');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function renderSidebarHistory(threads) {
    const host = document.querySelector('[data-threads-history]');
    if (!host) return;

    const activeThreadId = getActiveThreadIdFromUrl();

    if (!threads.length) {
      host.innerHTML = `
        <div class="thread-row">
          <div class="thread" style="cursor: default; opacity: .75;">
            <div class="thread__title">No threads yet</div>
            <div class="thread__meta">Start a new thread</div>
          </div>
        </div>
      `;
      return;
    }

    host.innerHTML = threads
      .map((t) => {
        const fullTitle = t.displayTitle || t.title || 'New thread';
        const shownTitle = truncate(fullTitle, 40) || 'New thread';
        const meta = formatDate(t.lastMessageAt || t.updatedAt);
        const isActive = activeThreadId && Number(activeThreadId) === Number(t.id);

        return `
          <div class="thread-row">
            <a class="thread ${isActive ? 'thread--active' : ''}"
               href="/chat?thread=${encodeURIComponent(t.id)}"
               title="${escapeHtml(fullTitle)}">
              <div class="thread__title">${escapeHtml(shownTitle)}</div>
              <div class="thread__meta">${escapeHtml(meta)}</div>
            </a>

            <button
              class="thread-delete"
              type="button"
              aria-label="Delete thread"
              title="Delete thread"
              data-thread-delete="${escapeHtml(String(t.id))}">
              ${getDeleteButtonSvg()}
            </button>
          </div>
        `;
      })
      .join('');
  }

  function renderMobileThreadsList(threads) {
    const host = document.querySelector('[data-threads-list]');
    if (!host) return;

    if (!threads.length) {
      host.innerHTML = `
        <div class="thread-card-row">
          <div class="thread-card" role="listitem" style="cursor: default; opacity: .75;">
            <div class="thread-card__title">No threads yet</div>
            <div class="thread-card__meta">Tap "+ New thread" to start</div>
          </div>
        </div>
      `;
      return;
    }

    host.innerHTML = threads
      .map((t) => {
        const fullTitle = t.displayTitle || t.title || 'New thread';
        const shownTitle = truncate(fullTitle, 44) || 'New thread';
        const meta = formatDate(t.lastMessageAt || t.updatedAt);

        return `
          <div class="thread-card-row" role="listitem">
            <a class="thread-card"
               href="/chat?thread=${encodeURIComponent(t.id)}"
               title="${escapeHtml(fullTitle)}">
              <div class="thread-card__title">${escapeHtml(shownTitle)}</div>
              <div class="thread-card__meta">${escapeHtml(meta)}</div>
            </a>

            <button
              class="thread-card-delete"
              type="button"
              aria-label="Delete thread"
              title="Delete thread"
              data-thread-delete="${escapeHtml(String(t.id))}">
              ${getDeleteButtonSvg()}
            </button>
          </div>
        `;
      })
      .join('');
  }

  function setNewThreadButtonsBusy(busy) {
    const buttons = document.querySelectorAll('[data-new-thread]');
    for (const el of buttons) {
      if (!(el instanceof HTMLElement)) continue;
      el.dataset.busy = busy ? '1' : '0';

      if (el instanceof HTMLButtonElement) {
        el.disabled = busy;
      }
    }
  }

  function wireNewThreadButtons() {
    const buttons = document.querySelectorAll('[data-new-thread]');
    for (const btn of buttons) {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (isCreatingThread) return;

        isCreatingThread = true;
        setNewThreadButtonsBusy(true);

        try {
          const created = await fetchJson('/api/threads', {
            method: 'POST',
            body: JSON.stringify({}),
          });

          const threadId = Number(created?.threadId);
          if (!Number.isFinite(threadId) || threadId <= 0) {
            throw new Error('Failed to create thread (invalid response).');
          }

          window.location.href = `/chat?thread=${encodeURIComponent(String(threadId))}`;
        } catch (err) {
          alert(err?.message || String(err));
          isCreatingThread = false;
          setNewThreadButtonsBusy(false);
        }
      });
    }
  }

  function wireDeleteButtons() {
    document.addEventListener('click', async (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;

      const btn = target.closest('[data-thread-delete]');
      if (!btn) return;

      e.preventDefault();
      e.stopPropagation();

      const raw = btn.getAttribute('data-thread-delete') || '';
      const threadId = Number(raw);

      if (!Number.isFinite(threadId) || threadId <= 0) return;

      const ok = window.confirm('Delete this thread and all its messages?');
      if (!ok) return;

      try {
        await fetchJson(`/api/threads/${encodeURIComponent(String(threadId))}`, {
          method: 'DELETE',
        });

        const activeThreadId = getActiveThreadIdFromUrl();
        if (window.location.pathname.startsWith('/chat') && activeThreadId === threadId) {
          window.location.href = '/threads';
          return;
        }

        const data = await fetchJson('/api/threads', { method: 'GET' });
        const threads = Array.isArray(data?.threads) ? data.threads : [];
        renderSidebarHistory(threads);
        renderMobileThreadsList(threads);
      } catch (err) {
        alert(err?.message || String(err));
      }
    });
  }

  async function init() {
    wireNewThreadButtons();
    wireDeleteButtons();

    try {
      const data = await fetchJson('/api/threads', { method: 'GET' });
      const threads = Array.isArray(data?.threads) ? data.threads : [];

      renderSidebarHistory(threads);
      renderMobileThreadsList(threads);
    } catch (err) {
      console.error('Failed to load threads:', err);
      
      const host1 = document.querySelector('[data-threads-history]');
      if (host1) {
        host1.innerHTML = `
          <div class="thread-row">
            <div class="thread" style="cursor: default; opacity: .75;">
              <div class="thread__title">Failed to load</div>
              <div class="thread__meta">${escapeHtml(err?.message || String(err))}</div>
            </div>
          </div>
        `;
      }

      const host2 = document.querySelector('[data-threads-list]');
      if (host2) {
        host2.innerHTML = `
          <div class="thread-card-row" role="listitem">
            <div class="thread-card">
              <div class="thread-card__title">Failed to load threads</div>
              <div class="thread-card__meta">${escapeHtml(err?.message || String(err))}</div>
            </div>
          </div>
        `;
      }
    }
  }

  init();
})();