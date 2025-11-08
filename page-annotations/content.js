// (No Tampermonkey header here)

// Wrap in an IIFE to avoid leaking globals
(function () {
  if (window.__annotation_injected) return;
  window.__annotation_injected = true;

  // If you’d rather store per path (more stable than full href):
  // const keyForPage = () => `annotations|${location.origin}${location.pathname}`;
  const keyForPage = () => `annotations|${location.href}`;

  function getAnnotations() {
    try {
      return JSON.parse(localStorage.getItem(keyForPage()) || '[]');
    } catch (e) {
      console.error('failed parse annotations', e);
      return [];
    }
  }
  function saveAnnotation(a) {
    const all = getAnnotations();
    all.push(a);
    localStorage.setItem(keyForPage(), JSON.stringify(all));
    window.dispatchEvent(new Event('annotationsUpdated'));
  }
  function clearAnnotations() {
    localStorage.removeItem(keyForPage());
    window.dispatchEvent(new Event('annotationsUpdated'));
  }

  // --- styles
  const style = document.createElement('style');
  style.textContent = `
    .annotation-sidebar { position: fixed; right: 0; top: 0; bottom: 0; width: 320px; background: #f7fafc; border-left: 1px solid #e2e8f0; padding: 12px; box-shadow: -4px 0 12px rgba(0,0,0,0.06); z-index: 2147483646; overflow: auto; font-family: system-ui, Arial; }
    .annotation-toggle { position: fixed; right: 320px; top: 12px; z-index: 2147483647; }
    .annotation-popup { position: absolute; background: white; border: 1px solid #e2e8f0; padding: 8px; border-radius: 6px; box-shadow: 0 6px 20px rgba(0,0,0,0.08); z-index: 2147483647; }
    mark.annotation { background: #fffb8f; padding: 0 2px; border-radius: 2px; }
    .annotation-highlight { box-shadow: 0 0 0 3px rgba(99,102,241,0.18); }
    .annotation-item { background: white; padding: 8px; margin-bottom: 8px; border-radius: 6px; border: 1px solid #edf2f7; }
    .annotation-empty { color: #718096; font-size: 13px; }
  `;
  document.head.appendChild(style);

  // --- sidebar
  const sidebar = document.createElement('aside');
  sidebar.className = 'annotation-sidebar';
  sidebar.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <strong>Annotations</strong>
      <button id="annotation-clear" style="color:#e53e3e;background:none;border:0;cursor:pointer">Clear</button>
    </div>
    <div id="annotation-list"></div>
  `;
  document.body.appendChild(sidebar);

  // --- toggle
  const toggle = document.createElement('button');
  toggle.className = 'annotation-toggle';
  toggle.textContent = 'Annotations';
  toggle.onclick = () => {
    sidebar.style.display = sidebar.style.display === 'none' ? 'block' : 'none';
  };
  document.body.appendChild(toggle);

  // --- popup
  const popup = document.createElement('div');
  popup.className = 'annotation-popup';
  popup.style.display = 'none';
  popup.innerHTML = `
    <div style="margin-bottom:6px"><textarea id="annotation-text" rows="3" style="width:240px"></textarea></div>
    <div style="text-align:right"><button id="annotation-cancel" style="margin-right:8px">✖</button><button id="annotation-save">Save</button></div>
  `;
  document.body.appendChild(popup);

  document.getElementById('annotation-clear').onclick = () => {
    if (confirm('Clear all annotations for this page?')) {
      clearAnnotations();
      renderSidebar();
      document.querySelectorAll('mark.annotation').forEach(m => {
        const parent = m.parentNode;
        parent.replaceChild(document.createTextNode(m.textContent), m);
      });
    }
  };

  document.getElementById('annotation-cancel').onclick = () => {
    popup.style.display = 'none';
    currentSelection = null;
  };

  let currentSelection = null;

  document.getElementById('annotation-save').onclick = () => {
    const ta = document.getElementById('annotation-text');
    const comment = ta.value.trim();
    if (!currentSelection || !currentSelection.text) return;
    saveAnnotation({ text: currentSelection.text, comment });
    popup.style.display = 'none';
    ta.value = '';
    markText(currentSelection.text, getAnnotations().length - 1);
    currentSelection = null;
    renderSidebar();
  };

  function renderSidebar() {
    const list = document.getElementById('annotation-list');
    const annotations = getAnnotations();
    list.innerHTML = '';
    if (annotations.length === 0) {
      const p = document.createElement('p');
      p.className = 'annotation-empty';
      p.textContent = 'No comments yet — select text to add one.';
      list.appendChild(p);
      return;
    }
    annotations.forEach((a, i) => {
      const div = document.createElement('div'); div.className = 'annotation-item';
      div.innerHTML = `<div style="font-style:italic;color:#4a5568;margin-bottom:6px">“${escapeHtml(a.text)}”</div><div>${escapeHtml(a.comment)}</div><div style="text-align:right;margin-top:6px"><button data-index="${i}" class="annotation-show">Show</button></div>`;
      list.appendChild(div);
    });
    list.querySelectorAll('.annotation-show').forEach(btn => {
      btn.onclick = () => {
        const idx = btn.getAttribute('data-index');
        const mark = document.querySelector(`mark.annotation[data-annotation-index="${idx}"]`);
        if (mark) {
          mark.scrollIntoView({ behavior:'smooth', block:'center' });
          mark.classList.add('annotation-highlight');
          setTimeout(()=>mark.classList.remove('annotation-highlight'), 2000);
        }
      };
    });
  }

  function escapeHtml(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function markText(text, index) {
    if (!text || text.trim().length === 0) return false;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;
    const needle = text;
    while (node = walker.nextNode()) {
      const val = node.nodeValue;
      const idx = val.indexOf(needle);
      if (idx >= 0 && node.parentElement && node.parentElement.closest && !node.parentElement.closest('script,style,textarea')) {
        const before = val.slice(0, idx);
        const matched = val.slice(idx, idx + needle.length);
        const after = val.slice(idx + needle.length);
        const frag = document.createDocumentFragment();
        if (before.length) frag.appendChild(document.createTextNode(before));
        const mark = document.createElement('mark');
        mark.className = 'annotation';
        mark.setAttribute('data-annotation-index', String(index));
        mark.textContent = matched;
        frag.appendChild(mark);
        if (after.length) frag.appendChild(document.createTextNode(after));
        node.parentNode.replaceChild(frag, node);
        return true;
      }
    }
    return false;
  }

  document.addEventListener('mouseup', () => {
    const selection = window.getSelection();
    if (!selection || selection.toString().trim().length === 0) return;
    const anchor = selection.anchorNode;
    if (!anchor || (anchor.nodeType === 3 && anchor.parentElement && anchor.parentElement.closest('.annotation-sidebar, .annotation-popup, .annotation-toggle'))) return;
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    currentSelection = { text: selection.toString() };
    popup.style.left = (rect.x + rect.width / 2 + window.scrollX) + 'px';
    const py = rect.y - 40 + window.scrollY;
    popup.style.top = (py < 8 ? rect.y + rect.height + 8 + window.scrollY : py) + 'px';
    popup.style.display = 'block';
    const ta = document.getElementById('annotation-text'); ta.value = '';
  });

  const annotations = getAnnotations();
  annotations.forEach((a, i) => markText(a.text, i));
  renderSidebar();

  window.addEventListener('annotationsUpdated', () => { renderSidebar(); });
})();
