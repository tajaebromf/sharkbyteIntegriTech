// Content script: selection → modal → highlight + save; sidebar injection; popup toggles.

const SB = (() => {
  const state = { sidebarFrame: null, quickBtn: null };

  const pageKey = () => {
    try { const u = new URL(location.href); return u.origin + u.pathname; }
    catch { return location.href; }
  };

  // ============== Storage helpers ==============
  async function getNotes() {
    const data = await chrome.storage.sync.get([pageKey()]);
    return data[pageKey()] || [];
  }
  async function setNotes(arr) {
    await chrome.storage.sync.set({ [pageKey()]: arr });
  }

  // ============== Highlight helpers ==============
  function wrapRangeWithSpan(range, id, comment) {
    const span = document.createElement('span');
    span.className = 'sb-highlight';
    span.dataset.id = id;
    span.setAttribute('data-comment', comment || '');
    try {
      range.surroundContents(span);
      return span;
    } catch {
      // If surroundContents fails due to partial node selection, split it
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
      return span;
    }
  }

  // Simple reapply: search visible text nodes and wrap the first match of the exact text snippet.
  function reapplyHighlights(notes) {
    // clear existing
    document.querySelectorAll('span.sb-highlight').forEach(s => {
      const parent = s.parentNode;
      while (s.firstChild) parent.insertBefore(s.firstChild, s);
      parent.removeChild(s);
      parent.normalize && parent.normalize();
    });

    for (const n of notes) {
      if (!n.text) continue;
      try {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode: (node) => {
            if (!node.nodeValue || !node.parentElement) return NodeFilter.FILTER_REJECT;
            const style = getComputedStyle(node.parentElement);
            if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        });
        let node;
        let done = false;
        while ((node = walker.nextNode()) && !done) {
          const idx = node.nodeValue.indexOf(n.text);
          if (idx !== -1) {
            const range = document.createRange();
            range.setStart(node, idx);
            range.setEnd(node, idx + n.text.length);
            const span = wrapRangeWithSpan(range, n.id, n.comment);
            span.addEventListener('click', () => span.scrollIntoView({ behavior: 'smooth', block: 'center' }));
            done = true; // only first match to avoid mass wrapping duplicates
          }
        }
      } catch {}
    }
  }

  // ============== Modal ==============
  function openModal(defaultComment = '') {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'sb-modal-backdrop';
      const modal = document.createElement('div');
      modal.className = 'sb-modal';
      modal.innerHTML = `
        <h3>Add a comment</h3>
        <textarea placeholder="Type your note…">${defaultComment}</textarea>
        <div class="row">
          <button class="sb-btn ghost" data-act="cancel">Cancel (Esc)</button>
          <button class="sb-btn primary" data-act="save">Save (Enter)</button>
        </div>
      `;
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);

      const textarea = modal.querySelector('textarea');
      textarea.focus();
      function done(ok) {
        document.body.removeChild(backdrop);
        resolve(ok ? textarea.value.trim() : null);
      }
      modal.addEventListener('click', (e) => {
        const act = e.target.getAttribute('data-act');
        if (act === 'cancel') done(false);
        if (act === 'save') done(true);
      });
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) done(false);
      });
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { document.removeEventListener('keydown', esc); done(false); }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { document.removeEventListener('keydown', esc); done(true); }
      });
    });
  }

  // ============== Quick add bubble near selection ==============
  function showQuickAddBubble(rect) {
    hideQuickAddBubble();
    const b = document.createElement('div');
    b.className = 'sb-quick-add';
    b.textContent = 'Add comment';
    b.style.top = `${window.scrollY + rect.top - 10}px`;
    b.style.left = `${window.scrollX + rect.right + 10}px`;
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', async () => {
      await createNoteFromSelection();
    });
    document.body.appendChild(b);
    state.quickBtn = b;
  }
  function hideQuickAddBubble() {
    if (state.quickBtn) {
      state.quickBtn.remove();
      state.quickBtn = null;
    }
  }

  // ============== Create Note ==============
  async function createNoteFromSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0).cloneRange();
    const selectedText = sel.toString().trim();
    if (!selectedText) return;

    const comment = await openModal('');
    if (comment === null) return;

    const id = crypto.randomUUID();
    const span = wrapRangeWithSpan(range, id, comment);
    span.scrollIntoView({ behavior: 'smooth', block: 'center' });

    const notes = await getNotes();
    notes.push({ id, text: selectedText, comment, ts: Date.now() });
    await setNotes(notes);
    reapplyHighlights(notes);
    syncSidebar();
  }

  // ============== Sidebar ==============
  function ensureSidebar() {
    if (state.sidebarFrame && document.body.contains(state.sidebarFrame)) return state.sidebarFrame;
    const frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('sidebar.html');
    frame.style.position = 'fixed';
    frame.style.top = '0';
    frame.style.right = '0';
    frame.style.width = '360px';
    frame.style.height = '100vh';
    frame.style.zIndex = '2147483645';
    frame.style.border = '0';
    frame.style.boxShadow = '0 0 0 1px rgba(0,0,0,.06), 0 20px 60px rgba(0,0,0,.25)';
    frame.dataset.sbSidebar = '1';
    document.body.appendChild(frame);
    state.sidebarFrame = frame;
    return frame;
  }
  function removeSidebar() {
    if (state.sidebarFrame) {
      state.sidebarFrame.remove();
      state.sidebarFrame = null;
    }
  }
  async function syncSidebar() {
    if (!state.sidebarFrame) return;
    const notes = await getNotes();
    state.sidebarFrame.contentWindow.postMessage({ type: 'SB_SIDEBAR_RENDER', notes }, '*');
  }

  // ============== Events ==============
  document.addEventListener('keydown', async (e) => {
    if (e.altKey && (e.key === 'h' || e.key === 'H')) {
      e.preventDefault();
      await createNoteFromSelection();
    }
  });

  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      hideQuickAddBubble();
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect && rect.width > 0 && rect.height > 0) showQuickAddBubble(rect);
  });
  window.addEventListener('scroll', hideQuickAddBubble);
  window.addEventListener('click', (e) => {
    if (state.quickBtn && !state.quickBtn.contains(e.target)) hideQuickAddBubble();
  });

  // Messaging from popup & sidebar
  chrome.runtime.onMessage.addListener(async (msg) => {
    if (msg?.type === 'SB_TOGGLE_SIDEBAR') {
      if (state.sidebarFrame) { removeSidebar(); }
      else {
        ensureSidebar();
        await syncSidebar();
      }
    }
    if (msg?.type === 'SB_REFRESH') {
      const notes = await getNotes();
      reapplyHighlights(notes);
      await syncSidebar();
    }
  });

  window.addEventListener('message', async (ev) => {
    const data = ev.data;
    if (!data) return;
    if (data.type === 'SB_REFRESH') {
      const notes = await getNotes();
      reapplyHighlights(notes);
      await syncSidebar();
    }
    if (data.type === 'SB_JUMP_TO') {
      const el = document.querySelector(`span.sb-highlight[data-id="${data.id}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.animate([{ outline: '2px solid transparent' }, { outline: '2px solid #111' }, { outline: '2px solid transparent' }], { duration: 1200 });
      }
    }
    if (data.type === 'SB_SIDEBAR_CLOSE') {
      removeSidebar();
    }
  });

  // Initial load
  (async () => {
    const notes = await getNotes();
    reapplyHighlights(notes);
  })();

  return { reapplyHighlights, syncSidebar };
})();
    