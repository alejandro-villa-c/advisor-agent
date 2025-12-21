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

    wrap.innerHTML = `
      <div class="msg__text">
        <div class="msg__content">${escapeHtml(text)}</div>
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

    thinkingElement = createMessageElement('assistant', 'Thinking', { isThinking: true });
    thinkingElement.querySelector('.msg__content').classList.add('thinking-dots');
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
        renderMessage('assistant', response.assistant.content);
      }
      // Otherwise, messages will arrive via WebSocket
    } catch (err) {
      removeThinkingPlaceholder();
      renderMessage(
        'assistant',
        `Error: ${err && err.message ? err.message : String(err)}`,
      );
    } finally {
      isSending = false;
      updateSendState();
    }
  }

  function initializeWebSocket() {
    // Connect to Socket.IO server
    socket = io({
      transports: ['websocket', 'polling'],
    });

    socket.on('connect', () => {
      console.log('WebSocket connected');
      
      // Register this socket for the user
      socket.emit('register', { threadId });
    });

    socket.on('disconnect', () => {
      console.log('WebSocket disconnected');
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
        
        renderMessage(data.message.role, data.message.content);
      }
    });

    socket.on('connect_error', (error) => {
      console.error('WebSocket connection error:', error);
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