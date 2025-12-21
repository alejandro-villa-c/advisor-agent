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

        const meta = t.lastMessageAt
          ? new Date(t.lastMessageAt).toLocaleString()
          : 'No messages yet';

        const isActive = activeThreadId && Number(activeThreadId) === Number(t.id);

        return `
          <div class="thread-row">
            <a class="thread ${isActive ? 'thread--active' : ''}"
               href="/chat?thread=${encodeURIComponent(t.id)}"
               title="${escapeHtml(fullTitle)}">
              <div class="thread__title">${escapeHtml(shownTitle)}</div>
              <div class="thread__meta" title="${escapeHtml(meta)}">${escapeHtml(truncate(meta, 26))}</div>
            </a>

            <button
              class="thread-delete"
              type="button"
              aria-label="Delete thread"
              title="Delete thread"
              data-thread-delete="${escapeHtml(String(t.id))}">
              🗑
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
            <div class="thread-card__meta">Tap “+ New thread” to start</div>
          </div>
        </div>
      `;
      return;
    }

    host.innerHTML = threads
      .map((t) => {
        const fullTitle = t.displayTitle || t.title || 'New thread';
        const shownTitle = truncate(fullTitle, 44) || 'New thread';

        const meta = t.lastMessageAt
          ? `Last updated: ${new Date(t.lastMessageAt).toLocaleString()}`
          : 'No messages yet';

        return `
          <div class="thread-card-row" role="listitem">
            <a class="thread-card"
               href="/chat?thread=${encodeURIComponent(t.id)}"
               title="${escapeHtml(fullTitle)}">
              <div class="thread-card__title">${escapeHtml(shownTitle)}</div>
              <div class="thread-card__meta" title="${escapeHtml(meta)}">${escapeHtml(truncate(meta, 52))}</div>
            </a>

            <button
              class="thread-card-delete"
              type="button"
              aria-label="Delete thread"
              title="Delete thread"
              data-thread-delete="${escapeHtml(String(t.id))}">
              🗑
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

      // Disable only if it's a real form control
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

        // If user deleted the thread currently open in /chat, bounce to /threads.
        const activeThreadId = getActiveThreadIdFromUrl();
        if (window.location.pathname.startsWith('/chat') && activeThreadId === threadId) {
          window.location.href = '/threads';
          return;
        }

        // Otherwise refresh lists in-place.
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
