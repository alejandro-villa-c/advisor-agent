(function () {
  const panel = document.querySelector('.panel');
  if (!panel) return;

  const threadId = Number(panel.getAttribute('data-thread-id') || '0');

  const contentInner = document.querySelector('.content__inner');
  const textarea = document.querySelector('.composer__input');
  const sendBtn = document.querySelector('.send-btn');

  const historyTab = document.querySelector('.tab:not(.tab--active)');
  const newThreadBtn = document.querySelector('[data-new-thread]');

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

  function createMessageElement(role, text, opts) {
    const wrap = document.createElement('div');
    wrap.className = role === 'user' ? 'msg msg--user' : 'msg msg--assistant';

    if (opts && opts.isThinking) {
      wrap.classList.add('msg--thinking');
    }

    wrap.innerHTML = `
      <div class="msg__text">
        <div class="msg__content">${escapeHtml(text)}</div>
      </div>
    `;

    return wrap;
  }

  function renderMessage(role, text, opts) {
    const el = createMessageElement(role, text, opts);
    contentInner.appendChild(el);
    return el;
  }

  function updateAssistantMessage(el, text) {
    if (!el) return;
    el.classList.remove('msg--thinking');

    el.innerHTML = `
      <div class="msg__text">
        <div class="msg__content">${escapeHtml(text)}</div>
      </div>
    `;
  }

  async function loadMessages() {
    contentInner.innerHTML = '';

    const data = await fetchJson(`/api/threads/${threadId}/messages`, { method: 'GET' });

    const msgs = Array.isArray(data && data.messages) ? data.messages : [];
    for (const m of msgs) {
      renderMessage(m.role, m.content);
    }

    scrollToBottom();
  }

  async function sendMessage(text) {
    if (isSending) return;

    isSending = true;
    updateSendState();

    renderMessage('user', text);

    textarea.value = '';
    textarea.focus();
    scrollToBottom();

    // Thinking placeholder
    const thinkingEl = renderMessage('assistant', 'Thinking', { isThinking: true });
    thinkingEl.querySelector('.msg__content').classList.add('thinking-dots');
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

      updateAssistantMessage(thinkingEl, assistantText);
      scrollToBottom();
    } catch (err) {
      updateAssistantMessage(
        thinkingEl,
        `Error: ${err && err.message ? err.message : String(err)}`,
      );
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

      sendMessage(text);
    }
  });

  if (sendBtn) {
    sendBtn.addEventListener('click', () => {
      const text = textarea.value.trim();
      if (!text) return;

      sendMessage(text);
    });
  }

  if (historyTab) {
    historyTab.addEventListener('click', () => {
      window.location.href = '/threads';
    });
  }

  if (newThreadBtn) {
    newThreadBtn.addEventListener('click', () => {
      // Assumes your server renders a fresh thread when you hit /chat
      window.location.href = '/chat';
    });
  }

  updateSendState();

  if (threadId > 0) {
    loadMessages().catch((err) => {
      renderMessage(
        'assistant',
        `Error loading messages: ${err && err.message ? err.message : String(err)}`,
      );
    });
  }
})();
