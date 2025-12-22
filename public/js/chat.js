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
  let socket = null;
  let thinkingElement = null;

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function formatTimestamp(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    const timeStr = date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

    if (diffMins < 1) {
      return 'Just now';
    } else if (diffMins < 60) {
      return `${diffMins}m ago`;
    } else if (diffHours < 24 && date.getDate() === now.getDate()) {
      return `Today at ${timeStr}`;
    } else if (diffDays === 1 || (diffHours < 48 && date.getDate() === now.getDate() - 1)) {
      return `Yesterday at ${timeStr}`;
    } else if (diffDays < 7) {
      const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
      return `${dayName} at ${timeStr}`;
    } else {
      const dateStr = date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
      });
      return `${dateStr} at ${timeStr}`;
    }
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

    const timestamp = opts && opts.createdAt ? formatTimestamp(opts.createdAt) : formatTimestamp(new Date().toISOString());

    wrap.innerHTML = `
      <div class="msg__text">
        <div class="msg__content">${escapeHtml(text)}</div>
        <div class="msg__timestamp">${escapeHtml(timestamp)}</div>
      </div>
    `;

    return wrap;
  }

  function renderMessage(role, text, opts) {
    // Skip empty messages
    if (!text || !text.trim()) return null;

    const el = createMessageElement(role, text, opts);
    contentInner.appendChild(el);
    scrollToBottom();
    return el;
  }

  function showThinkingPlaceholder() {
    // Remove any existing thinking placeholder first
    removeThinkingPlaceholder();

    thinkingElement = document.createElement('div');
    thinkingElement.className = 'msg msg--assistant msg--thinking';
    thinkingElement.innerHTML = `
      <div class="msg__text">
        <div class="msg__content thinking-dots">Thinking</div>
      </div>
    `;
    contentInner.appendChild(thinkingElement);
    scrollToBottom();
  }

  function removeThinkingPlaceholder() {
    if (thinkingElement && thinkingElement.parentNode) {
      thinkingElement.parentNode.removeChild(thinkingElement);
      thinkingElement = null;
    }
  }

  async function loadMessages() {
    contentInner.innerHTML = '';

    const data = await fetchJson(`/api/threads/${threadId}/messages`, { method: 'GET' });

    const msgs = Array.isArray(data && data.messages) ? data.messages : [];
    for (const m of msgs) {
      renderMessage(m.role, m.content, { createdAt: m.createdAt });
    }

    scrollToBottom();
  }

  async function sendMessage(text) {
    if (isSending) return;

    isSending = true;
    updateSendState();

    renderMessage('user', text, { createdAt: new Date().toISOString() });

    textarea.value = '';
    textarea.focus();

    // Show thinking placeholder while waiting for agent response
    showThinkingPlaceholder();

    try {
      const response = await fetchJson('/api/chat/message', {
        method: 'POST',
        body: JSON.stringify({ threadId, content: text }),
      });

      // If there's an immediate assistant response, render it
      if (response.assistant && response.assistant.content && response.assistant.content.trim()) {
        removeThinkingPlaceholder();
        renderMessage('assistant', response.assistant.content, { createdAt: new Date().toISOString() });
      }
      // Otherwise, messages will arrive via WebSocket
    } catch (err) {
      removeThinkingPlaceholder();
      renderMessage(
        'assistant',
        `Error: ${err && err.message ? err.message : String(err)}`,
        { createdAt: new Date().toISOString() }
      );
    } finally {
      isSending = false;
      updateSendState();
    }
  }

  function initializeWebSocket() {
    // Connect to Socket.IO server - prefer websocket to avoid proxy issues
    socket = io({
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      timeout: 20000,
    });

    socket.on('connect', () => {
      console.log('WebSocket connected:', socket.id);

      // Register this socket for the current thread
      // Fetch userId from the page or session
      fetch('/api/auth/me', { credentials: 'same-origin' })
        .then(res => res.json())
        .then(data => {
          const userId = data.userId || data.id;
          if (userId) {
            socket.emit('register', { userId, threadId });
            console.log('Registered socket for user', userId, 'thread', threadId);
          }
        })
        .catch(err => {
          console.warn('Could not fetch userId, registering with threadId only:', err);
          socket.emit('register', { threadId });
        });
    });

    socket.on('registered', (data) => {
      console.log('Socket registration confirmed:', data);
    });

    socket.on('disconnect', (reason) => {
      console.log('WebSocket disconnected:', reason);
    });

    socket.on('new-message', (data) => {
      console.log('Received new message:', data);

      // Only render if it's for the current thread
      if (data.threadId === threadId && data.message) {
        // Skip empty messages
        if (!data.message.content || !data.message.content.trim()) {
          return;
        }

        // Remove thinking placeholder when first real message arrives
        removeThinkingPlaceholder();

        renderMessage(data.message.role, data.message.content, {
          createdAt: data.message.createdAt || new Date().toISOString(),
        });
      }
    });

    socket.on('connect_error', (error) => {
      console.error('WebSocket connection error:', error);
    });

    socket.on('reconnect', (attemptNumber) => {
      console.log('WebSocket reconnected after', attemptNumber, 'attempts');
    });
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

  updateSendState();

  if (threadId > 0) {
    loadMessages().catch((err) => {
      renderMessage(
        'assistant',
        `Error loading messages: ${err && err.message ? err.message : String(err)}`,
        { createdAt: new Date().toISOString() }
      );
    });

    // Initialize WebSocket after loading initial messages
    initializeWebSocket();
  }

  // Clean up WebSocket on page unload
  window.addEventListener('beforeunload', () => {
    if (socket) {
      socket.disconnect();
    }
  });
})();