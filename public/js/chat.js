(function () {
  const panel = document.querySelector('.panel');
  if (!panel) return;

  const threadId = Number(panel.getAttribute('data-thread-id') || '0');

  const contentInner = document.querySelector('.content__inner');
  const textarea = document.querySelector('.composer__input');
  const sendBtn = document.querySelector('.send-btn');

  const historyTab = document.querySelector('.tab:not(.tab--active)');

  if (!contentInner || !textarea) return;

  let isSending = false;

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
    if (t.length <= max) return t;
    return `${t.slice(0, Math.max(0, max - 1))}…`;
  }

  async function fetchJson(url, options) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt || `${res.status} ${res.statusText}`);
    }

    return res.json();
  }

  function scrollToBottom() {
    const scroller = contentInner.parentElement;
    if (scroller) scroller.scrollTo(0, scroller.scrollHeight);
  }

  function updateSendState() {
    if (!sendBtn) return;
    const hasText = textarea.value.trim().length > 0;
    sendBtn.disabled = isSending || !hasText;
  }

  function normalizeCitations(meta) {
    const citations = meta && Array.isArray(meta.citations) ? meta.citations : [];
    return citations
      .map((c) => ({
        title: c && c.title == null ? null : String(c && c.title != null ? c.title : ''),
        chunkText: String(c && c.chunkText != null ? c.chunkText : ''),
      }))
      .filter((c) => c.source || c.title || c.sourceId || c.chunkText);
  }

  function renderSources(citations) {
    if (!citations.length) return '';

    const items = citations.map((c) => {
      const headerParts = [];
      if (c.title) headerParts.push(c.title);

      const header = headerParts.join(' — ') || 'Source';
      const snippet = truncate(c.chunkText, 220);

      return `
        <li class="sources__item">
          <div class="sources__header" title="${escapeHtml(header)}">${escapeHtml(truncate(header, 80))}}</div>
          ${snippet ? `<div class="sources__snippet" title="${escapeHtml(c.chunkText)}">${escapeHtml(snippet)}</div>` : ''}
        </li>
      `;
    });

    return `
      <details class="sources">
        <summary class="sources__summary">Sources (${citations.length})</summary>
        <ol class="sources__list">
          ${items.join('')}
        </ol>
      </details>
    `;
  }

  function renderMessage(role, text, meta) {
    const wrap = document.createElement('div');
    wrap.className = role === 'user' ? 'msg msg--user' : 'msg msg--assistant';

    const sourcesHtml = role === 'assistant' ? renderSources(normalizeCitations(meta)) : '';

    wrap.innerHTML = `
      <div class="msg__text">
        <div class="msg__content">${escapeHtml(text)}</div>
        ${sourcesHtml}
      </div>
    `;

    contentInner.appendChild(wrap);
  }

  async function loadMessages() {
    contentInner.innerHTML = '';

    const data = await fetchJson(`/api/threads/${threadId}/messages`, {
      method: 'GET',
    });

    const msgs = Array.isArray(data && data.messages) ? data.messages : [];
    for (const m of msgs) {
      renderMessage(m.role, m.content, m.meta);
    }

    scrollToBottom();
  }

  async function sendMessage(text) {
    if (isSending) return;

    isSending = true;
    updateSendState();

    renderMessage('user', text, null);

    textarea.value = '';
    textarea.focus();
    scrollToBottom();

    try {
      const data = await fetchJson('/api/chat/message', {
        method: 'POST',
        body: JSON.stringify({ threadId, content: text }),
      });

      const assistantText =
        (data && data.assistant && typeof data.assistant === 'object' && data.assistant.content) ||
        (data && typeof data.assistant === 'string' && data.assistant) ||
        '';

      const citations = Array.isArray(data && data.citations) ? data.citations : [];
      renderMessage('assistant', assistantText, { citations });

      scrollToBottom();
    } finally {
      isSending = false;
      updateSendState();
    }
  }

  textarea.addEventListener('input', updateSendState);

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();

      const text = textarea.value.trim();
      if (!text) return;

      sendMessage(text).catch((err) => {
        renderMessage('assistant', `Error: ${err && err.message ? err.message : String(err)}`, null);
      });
    }
  });

  if (sendBtn) {
    sendBtn.addEventListener('click', () => {
      const text = textarea.value.trim();
      if (!text) return;

      sendMessage(text).catch((err) => {
        renderMessage('assistant', `Error: ${err && err.message ? err.message : String(err)}`, null);
      });
    });
  }

  if (historyTab) {
    historyTab.addEventListener('click', () => {
      window.location.href = '/threads';
    });
  }

  updateSendState();

  if (threadId > 0) {
    loadMessages().catch((err) => {
      renderMessage('assistant', `Error loading messages: ${err && err.message ? err.message : String(err)}`, null);
    });
  }
})();
