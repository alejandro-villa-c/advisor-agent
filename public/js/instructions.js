(function() {
  'use strict';

  const instructionsList = document.getElementById('instructions-list');
  const activityList = document.getElementById('activity-list');
  const createForm = document.getElementById('create-instruction-form');
  const pauseAllBtn = document.getElementById('pause-all-btn');
  const resumeAllBtn = document.getElementById('resume-all-btn');
  const tabBtns = document.querySelectorAll('.instructions-tabs__btn');
  const instructionCountEl = document.getElementById('instruction-count');

  // Rate limit elements
  const rateLimitCount = document.getElementById('rate-limit-count');
  const rateLimitMax = document.getElementById('rate-limit-max');
  const rateLimitFill = document.getElementById('rate-limit-fill');

  // Reference panel elements
  const referencePanel = document.getElementById('reference-panel');
  const showReferenceBtn = document.getElementById('show-reference-btn');
  const closeReferenceBtn = document.getElementById('close-reference-btn');

  // =========================================================================
  // WebSocket Connection
  // =========================================================================
  let socket = null;

  function initWebSocket() {
    if (typeof io === 'undefined') {
      console.warn('[Instructions] Socket.IO not available');
      return;
    }

    socket = io({
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      timeout: 20000,
    });

    socket.on('connect', () => {
      console.log('[Instructions] WebSocket connected:', socket.id);

      // Fetch userId and register
      fetch('/api/auth/me', { credentials: 'same-origin' })
        .then(res => res.json())
        .then(data => {
          const userId = data.userId || data.id;
          if (userId) {
            socket.emit('register', { userId });
            console.log('[Instructions] Registered socket for user', userId);
          }
        })
        .catch(err => {
          console.warn('[Instructions] Could not fetch userId:', err);
          socket.emit('register', {});
        });
    });

    socket.on('registered', (data) => {
      console.log('[Instructions] Socket registration confirmed:', data);
    });

    socket.on('disconnect', (reason) => {
      console.log('[Instructions] WebSocket disconnected:', reason);
    });

    // Listen for activity log updates
    socket.on('activity_log', (data) => {
      console.log('[Instructions] Activity log event:', data);
      handleActivityLogEvent(data);
    });

    socket.on('connect_error', (error) => {
      console.error('[Instructions] WebSocket connection error:', error);
    });

    socket.on('reconnect', (attemptNumber) => {
      console.log('[Instructions] WebSocket reconnected after', attemptNumber, 'attempts');
    });
  }

  function handleActivityLogEvent(activity) {
    // Update or add the activity item
    const existingItem = activityList.querySelector(`[data-activity-id="${activity.id}"]`);
    
    if (existingItem) {
      // Update existing item (e.g., running -> completed)
      existingItem.outerHTML = renderActivityItem(activity);
    } else {
      // Remove empty state if present
      const emptyState = activityList.querySelector('.instructions-empty');
      if (emptyState) {
        emptyState.remove();
      }

      // Add new item at the top
      const newItem = document.createElement('div');
      newItem.innerHTML = renderActivityItem(activity);
      activityList.insertBefore(newItem.firstElementChild, activityList.firstChild);
    }

    // Show notification for completed/failed actions
    if (activity.status === 'completed') {
      showNotification(`Action completed: ${activity.actionTaken}`, 'success');
    } else if (activity.status === 'failed') {
      showNotification(`Action failed: ${activity.error || 'Unknown error'}`, 'error');
    }

    // Update rate limit display
    loadRateLimit();
  }

  function renderActivityItem(action) {
    return `
      <div class="activity-item ${action.status === 'failed' ? 'activity-item--error' : ''}" data-activity-id="${action.id}">
        <div class="activity-item__header">
          <span class="activity-item__icon">${getTriggerIcon(action.triggerType)}</span>
          <span class="activity-item__trigger">${escapeHtml(action.triggerSummary)}</span>
          <span class="activity-item__time">${action.createdAt ? formatRelativeTime(action.createdAt) : 'Just now'}</span>
        </div>
        <div class="activity-item__instruction">
          Instruction: "${escapeHtml(action.instructionText)}"
        </div>
        <div class="activity-item__body">
          <span class="activity-item__action">${escapeHtml(action.actionTaken)}</span>
          ${getStatusBadge(action.status)}
        </div>
        ${action.error ? `<div class="activity-item__error">Error: ${escapeHtml(action.error)}</div>` : ''}
      </div>
    `;
  }

  // Initialize WebSocket
  initWebSocket();

  // =========================================================================
  // Reference Panel Toggle
  // =========================================================================
  if (showReferenceBtn && referencePanel) {
    showReferenceBtn.addEventListener('click', () => {
      referencePanel.style.display = referencePanel.style.display === 'none' ? 'block' : 'none';
    });
  }

  if (closeReferenceBtn && referencePanel) {
    closeReferenceBtn.addEventListener('click', () => {
      referencePanel.style.display = 'none';
    });
  }

  // =========================================================================
  // Tab Switching
  // =========================================================================
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      
      tabBtns.forEach(b => b.classList.remove('instructions-tabs__btn--active'));
      btn.classList.add('instructions-tabs__btn--active');
      
      document.querySelectorAll('.instructions-tab-content').forEach(c => {
        c.classList.remove('instructions-tab-content--active');
      });
      document.getElementById('tab-' + tab).classList.add('instructions-tab-content--active');

      // Load activity when switching to that tab
      if (tab === 'activity') {
        loadActivity();
      }
    });
  });

  // =========================================================================
  // API Helpers
  // =========================================================================
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

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatDate(isoString) {
    if (!isoString) return '—';
    try {
      const d = new Date(isoString);
      return new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Santo_Domingo',
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(d);
    } catch {
      return isoString;
    }
  }

  function formatRelativeTime(isoString) {
    if (!isoString) return '';
    try {
      const d = new Date(isoString);
      const now = new Date();
      const diffMs = now - d;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      if (diffDays < 7) return `${diffDays}d ago`;
      return formatDate(isoString);
    } catch {
      return '';
    }
  }

  function getTriggerIcon(type) {
    const icons = {
      gmail_received: '📧',
      gmail_sent: '📤',
      calendar_event_created: '📅',
      calendar_event_updated: '🔄',
      calendar_event_deleted: '🗑️',
      hubspot_contact_created: '👤',
      hubspot_contact_updated: '✏️',
      hubspot_contact_deleted: '❌',
      hubspot_note_created: '📝',
      hubspot_note_deleted: '🗑️',
    };
    return icons[type] || '⚡';
  }

  function getStatusBadge(status) {
    const classes = {
      completed: 'instructions-badge--success',
      failed: 'instructions-badge--error',
      running: 'instructions-badge--warning',
      pending: 'instructions-badge--info',
      skipped: 'instructions-badge--muted',
    };
    const cls = classes[status] || '';
    return `<span class="instructions-badge ${cls}">${escapeHtml(status.toUpperCase())}</span>`;
  }

  // =========================================================================
  // Load Instructions
  // =========================================================================
  async function loadInstructions() {
    try {
      const data = await fetchJson('/api/instructions');
      
      if (!data.instructions || data.instructions.length === 0) {
        instructionsList.innerHTML = `
          <div class="instructions-empty">
            <div class="instructions-empty__icon">📋</div>
            <div class="instructions-empty__title">No instructions yet</div>
            <div class="instructions-empty__text">
              Create your first ongoing instruction above. Click <strong>Reference</strong> to see available triggers and tools.
            </div>
          </div>
        `;
        instructionCountEl.textContent = '0 instructions';
        return;
      }

      const activeCount = data.instructions.filter(i => i.isActive).length;
      instructionCountEl.textContent = `${data.instructions.length} instruction${data.instructions.length !== 1 ? 's' : ''} (${activeCount} active)`;

      instructionsList.innerHTML = data.instructions.map(inst => `
        <div class="instruction-card ${inst.isActive ? '' : 'instruction-card--inactive'}" data-id="${inst.id}">
          <div class="instruction-card__content">
            <div class="instruction-card__text">${escapeHtml(inst.instruction)}</div>
            <div class="instruction-card__meta">
              Created ${formatRelativeTime(inst.createdAt)} · 
              <span class="instruction-card__status">${inst.isActive ? '✅ Active' : '⏸️ Paused'}</span>
            </div>
          </div>
          <div class="instruction-card__actions">
            <button 
              class="instruction-card__btn instruction-card__btn--toggle" 
              data-action="toggle" 
              data-id="${inst.id}"
              title="${inst.isActive ? 'Pause' : 'Resume'}"
            >
              ${inst.isActive ? '⏸️' : '▶️'}
            </button>
            <button 
              class="instruction-card__btn instruction-card__btn--delete" 
              data-action="delete" 
              data-id="${inst.id}"
              title="Delete"
            >
              🗑️
            </button>
          </div>
        </div>
      `).join('');

      // Attach event listeners
      instructionsList.querySelectorAll('[data-action="toggle"]').forEach(btn => {
        btn.addEventListener('click', () => toggleInstruction(btn.dataset.id));
      });

      instructionsList.querySelectorAll('[data-action="delete"]').forEach(btn => {
        btn.addEventListener('click', () => deleteInstruction(btn.dataset.id));
      });

    } catch (err) {
      console.error('Failed to load instructions:', err);
      instructionsList.innerHTML = `
        <div class="notice notice--error">
          Failed to load instructions: ${escapeHtml(err.message)}
        </div>
      `;
    }
  }

  // =========================================================================
  // Load Activity
  // =========================================================================
  async function loadActivity() {
    try {
      const data = await fetchJson('/api/instructions/activity');
      
      if (!data.actions || data.actions.length === 0) {
        activityList.innerHTML = `
          <div class="instructions-empty">
            <div class="instructions-empty__icon">📊</div>
            <div class="instructions-empty__title">No activity yet</div>
            <div class="instructions-empty__text">
              When your instructions trigger actions, they'll appear here.
            </div>
          </div>
        `;
        return;
      }

      activityList.innerHTML = data.actions.map(action => renderActivityItem(action)).join('');

    } catch (err) {
      console.error('Failed to load activity:', err);
      activityList.innerHTML = `
        <div class="notice notice--error">
          Failed to load activity: ${escapeHtml(err.message)}
        </div>
      `;
    }
  }

  // =========================================================================
  // Load Rate Limit
  // =========================================================================
  async function loadRateLimit() {
    try {
      const data = await fetchJson('/api/instructions/rate-limit');
      const used = data.maxPerHour - data.remaining;
      const percent = Math.min(100, Math.round((used / data.maxPerHour) * 100));

      rateLimitCount.textContent = used;
      rateLimitMax.textContent = data.maxPerHour;
      rateLimitFill.style.width = percent + '%';

      // Change color if nearing limit
      if (percent >= 80) {
        rateLimitFill.style.background = '#ef4444';
      } else if (percent >= 50) {
        rateLimitFill.style.background = '#f59e0b';
      } else {
        rateLimitFill.style.background = '#3b82f6';
      }
    } catch (err) {
      console.error('Failed to load rate limit:', err);
    }
  }

  // =========================================================================
  // Create Instruction
  // =========================================================================
  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const input = createForm.querySelector('input[name="instruction"]');
    const instruction = input.value.trim();

    if (!instruction) return;

    const submitBtn = createForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Adding...';

    try {
      const data = await fetchJson('/api/instructions', {
        method: 'POST',
        body: JSON.stringify({ instruction }),
      });

      if (data.success) {
        input.value = '';
        await loadInstructions();
        showNotification('Instruction added successfully!', 'success');
      } else if (data.conflict?.hasConflict) {
        const msg = data.conflict.reason || 'This instruction conflicts with an existing one.';
        showNotification(`Conflict detected: ${msg}`, 'error');
      } else {
        showNotification('Failed to add instruction', 'error');
      }
    } catch (err) {
      console.error('Failed to create instruction:', err);
      showNotification(`Error: ${err.message}`, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Add Instruction';
    }
  });

  // =========================================================================
  // Toggle Instruction
  // =========================================================================
  async function toggleInstruction(id) {
    try {
      const data = await fetchJson(`/api/instructions/${id}/toggle`, { method: 'POST' });
      if (data.success) {
        await loadInstructions();
      }
    } catch (err) {
      console.error('Failed to toggle instruction:', err);
      showNotification(`Error: ${err.message}`, 'error');
    }
  }

  // =========================================================================
  // Delete Instruction
  // =========================================================================
  async function deleteInstruction(id) {
    if (!confirm('Are you sure you want to delete this instruction?')) return;

    try {
      const data = await fetchJson(`/api/instructions/${id}`, { method: 'DELETE' });
      if (data.success) {
        await loadInstructions();
        showNotification('Instruction deleted', 'success');
      }
    } catch (err) {
      console.error('Failed to delete instruction:', err);
      showNotification(`Error: ${err.message}`, 'error');
    }
  }

  // =========================================================================
  // Pause/Resume All
  // =========================================================================
  pauseAllBtn.addEventListener('click', async () => {
    try {
      const data = await fetchJson('/api/instructions/pause-all', { method: 'POST' });
      if (data.success) {
        await loadInstructions();
        showNotification(`Paused ${data.count} instruction(s)`, 'success');
      }
    } catch (err) {
      console.error('Failed to pause all:', err);
      showNotification(`Error: ${err.message}`, 'error');
    }
  });

  resumeAllBtn.addEventListener('click', async () => {
    try {
      const data = await fetchJson('/api/instructions/resume-all', { method: 'POST' });
      if (data.success) {
        await loadInstructions();
        showNotification(`Resumed ${data.count} instruction(s)`, 'success');
      }
    } catch (err) {
      console.error('Failed to resume all:', err);
      showNotification(`Error: ${err.message}`, 'error');
    }
  });

  // =========================================================================
  // Notification Helper
  // =========================================================================
  function showNotification(message, type) {
    // Remove existing notifications
    document.querySelectorAll('.instructions-notification').forEach(el => el.remove());

    const notification = document.createElement('div');
    notification.className = `instructions-notification instructions-notification--${type}`;
    notification.textContent = message;
    
    document.body.appendChild(notification);

    // Auto-remove after 4 seconds
    setTimeout(() => {
      notification.classList.add('instructions-notification--hiding');
      setTimeout(() => notification.remove(), 300);
    }, 4000);
  }

  // =========================================================================
  // Initial Load
  // =========================================================================
  loadInstructions();
  loadRateLimit();

  // Refresh rate limit every minute
  setInterval(loadRateLimit, 60000);
})();