// Client-side JavaScript for HubSpot contact and note management
// Include this in your settings page or as a separate script file

class HubSpotManager {
  constructor() {
    this.currentContactId = null;
    this.contactsAfter = null;
    this.init();
  }

  init() {
    this.attachEventListeners();
    this.loadContacts();
  }

  attachEventListeners() {
    // Create contact form
    const createContactForm = document.getElementById('create-contact-form');
    if (createContactForm) {
      createContactForm.addEventListener('submit', (e) => this.handleCreateContact(e));
    }

    // Create note form
    const createNoteForm = document.getElementById('create-note-form');
    if (createNoteForm) {
      createNoteForm.addEventListener('submit', (e) => this.handleCreateNote(e));
    }

    // Load more contacts button
    const loadMoreBtn = document.getElementById('load-more-contacts');
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', () => this.loadMoreContacts());
    }

    // Close modal handlers
    const closeButtons = document.querySelectorAll('.modal-close');
    closeButtons.forEach(btn => {
      btn.addEventListener('click', () => this.closeModals());
    });

    // Click outside modal to close
    window.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal')) {
        this.closeModals();
      }
    });
  }

  async loadContacts(after = null) {
    const container = document.getElementById('contacts-list');
    if (!container) return;

    if (!after) {
      container.innerHTML = '<div style="padding: 20px; text-align: center;">Loading contacts...</div>';
    }

    try {
      const url = after 
        ? `/api/hubspot/contacts?limit=20&after=${after}`
        : '/api/hubspot/contacts?limit=20';
      
      const response = await fetch(url);
      const data = await response.json();

      if (!after) {
        container.innerHTML = '';
      }

      if (data.contacts.length === 0 && !after) {
        container.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--muted);">No contacts found. Create your first contact above!</div>';
        return;
      }

      data.contacts.forEach(contact => {
        container.appendChild(this.createContactCard(contact));
      });

      this.contactsAfter = data.nextAfter || null;
      
      const loadMoreBtn = document.getElementById('load-more-contacts');
      if (loadMoreBtn) {
        loadMoreBtn.style.display = data.hasMore ? 'block' : 'none';
      }
    } catch (error) {
      console.error('Error loading contacts:', error);
      this.showError('Failed to load contacts');
    }
  }

  async loadMoreContacts() {
    if (this.contactsAfter) {
      await this.loadContacts(this.contactsAfter);
    }
  }

  createContactCard(contact) {
    const card = document.createElement('div');
    card.className = 'contact-card';
    card.dataset.contactId = contact.id;

    const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'No name';
    const email = contact.email || 'No email';

    card.innerHTML = `
      <div class="contact-card__header">
        <div class="contact-card__info">
          <div class="contact-card__name">${this.escapeHtml(name)}</div>
          <div class="contact-card__email">${this.escapeHtml(email)}</div>
        </div>
        <div class="contact-card__actions">
          <button class="btn btn--ghost btn--small" onclick="hubspotMgr.viewContactNotes('${contact.id}')">
            View Notes
          </button>
          <button class="btn btn--ghost btn--small btn--danger" onclick="hubspotMgr.deleteContact('${contact.id}')">
            Delete
          </button>
        </div>
      </div>
    `;

    return card;
  }

  async viewContactNotes(contactId) {
    this.currentContactId = contactId;
    const modal = document.getElementById('notes-modal');
    const notesList = document.getElementById('notes-list');
    
    if (!modal || !notesList) return;

    modal.style.display = 'flex';
    notesList.innerHTML = '<div style="padding: 20px; text-align: center;">Loading notes...</div>';

    try {
      const response = await fetch(`/api/hubspot/contacts/${contactId}/notes?limit=50`);
      const data = await response.json();

      notesList.innerHTML = '';

      if (data.results.length === 0) {
        notesList.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--muted);">No notes yet. Add one below!</div>';
        return;
      }

      data.results.forEach(note => {
        notesList.appendChild(this.createNoteCard(note));
      });
    } catch (error) {
      console.error('Error loading notes:', error);
      this.showError('Failed to load notes');
    }
  }

  createNoteCard(note) {
    const card = document.createElement('div');
    card.className = 'note-card';
    card.dataset.noteId = note.id;

    const timestamp = note.timestamp 
      ? new Date(isNaN(note.timestamp) ? note.timestamp : Number(note.timestamp)).toLocaleString()
      : 'Unknown date';

    card.innerHTML = `
      <div class="note-card__header">
        <div class="note-card__timestamp">${this.escapeHtml(timestamp)}</div>
        <button class="btn btn--ghost btn--small btn--danger" onclick="hubspotMgr.deleteNote('${note.id}')">
          Delete
        </button>
      </div>
      <div class="note-card__body">${this.escapeHtml(note.body || '')}</div>
    `;

    return card;
  }

  async handleCreateContact(e) {
    e.preventDefault();
    
    const form = e.target;
    const email = form.querySelector('[name="email"]').value;
    const firstName = form.querySelector('[name="firstName"]').value;
    const lastName = form.querySelector('[name="lastName"]').value;

    try {
      const response = await fetch('/api/hubspot/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, firstName, lastName }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to create contact');
      }

      this.showSuccess('Contact created successfully');
      form.reset();
      this.loadContacts();
    } catch (error) {
      console.error('Error creating contact:', error);
      this.showError(error.message || 'Failed to create contact');
    }
  }

  async handleCreateNote(e) {
    e.preventDefault();
    
    if (!this.currentContactId) {
      this.showError('No contact selected');
      return;
    }

    const form = e.target;
    const text = form.querySelector('[name="noteText"]').value;

    try {
      const response = await fetch(`/api/hubspot/contacts/${this.currentContactId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to create note');
      }

      this.showSuccess('Note created successfully');
      form.reset();
      this.viewContactNotes(this.currentContactId);
    } catch (error) {
      console.error('Error creating note:', error);
      this.showError(error.message || 'Failed to create note');
    }
  }

  async deleteContact(contactId) {
    if (!confirm('Are you sure you want to delete this contact? This cannot be undone.')) {
      return;
    }

    try {
      const response = await fetch(`/api/hubspot/contacts/${contactId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete contact');
      }

      this.showSuccess('Contact deleted successfully');
      
      const card = document.querySelector(`[data-contact-id="${contactId}"]`);
      if (card) {
        card.remove();
      }
    } catch (error) {
      console.error('Error deleting contact:', error);
      this.showError('Failed to delete contact');
    }
  }

  async deleteNote(noteId) {
    if (!confirm('Are you sure you want to delete this note? This cannot be undone.')) {
      return;
    }

    try {
      const response = await fetch(`/api/hubspot/notes/${noteId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete note');
      }

      this.showSuccess('Note deleted successfully');
      
      const card = document.querySelector(`[data-note-id="${noteId}"]`);
      if (card) {
        card.remove();
      }
    } catch (error) {
      console.error('Error deleting note:', error);
      this.showError('Failed to delete note');
    }
  }

  closeModals() {
    const modals = document.querySelectorAll('.modal');
    modals.forEach(modal => {
      modal.style.display = 'none';
    });
    this.currentContactId = null;
  }

  showSuccess(message) {
    this.showNotification(message, 'success');
  }

  showError(message) {
    this.showNotification(message, 'error');
  }

  showNotification(message, type) {
    const container = document.getElementById('notification-container') || this.createNotificationContainer();
    
    const notification = document.createElement('div');
    notification.className = `notification notification--${type}`;
    notification.textContent = message;
    
    container.appendChild(notification);
    
    setTimeout(() => {
      notification.style.animation = 'slideOut 0.3s ease';
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }

  createNotificationContainer() {
    const container = document.createElement('div');
    container.id = 'notification-container';
    container.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      gap: 10px;
    `;
    document.body.appendChild(container);
    return container;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize when DOM is ready
let hubspotMgr;
document.addEventListener('DOMContentLoaded', () => {
  hubspotMgr = new HubSpotManager();
});