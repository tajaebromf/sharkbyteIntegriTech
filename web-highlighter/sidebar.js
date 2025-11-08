(async function () {
  const list = document.getElementById('sb-list');
  const empty = document.getElementById('sb-empty');
  const closeBtn = document.getElementById('sb-close');

  closeBtn.addEventListener('click', () => {
    parent.postMessage({ type: 'SB_SIDEBAR_CLOSE' }, '*');
  });

  function pageKey() {
    try { return new URL(location.href).origin + new URL(location.href).pathname; }
    catch { return location.href; }
  }

  function render(notes) {
    list.innerHTML = '';
    if (!notes || notes.length === 0) {
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    for (const n of notes) {
      const li = document.createElement('li');
      li.className = 'note';
      li.innerHTML = `
        <div class="text">${escapeHtml(n.text)}</div>
        <div class="comment">${escapeHtml(n.comment)}</div>
        <div class="meta">
          <span>#${n.id.slice(0,6)}</span>
          <span>${new Date(n.ts).toLocaleString()}</span>
        </div>
        <div class="row">
          <button class="jump">Jump</button>
          <button class="delete">Delete</button>
        </div>
      `;
      li.querySelector('.jump').onclick = () => {
        parent.postMessage({ type: 'SB_JUMP_TO', id: n.id }, '*');
      };
      li.querySelector('.delete').onclick = async () => {
        const { [pageKey()]: arr = [] } = await chrome.storage.sync.get([pageKey()]);
        const next = arr.filter(x => x.id !== n.id);
        await chrome.storage.sync.set({ [pageKey()]: next });
        parent.postMessage({ type: 'SB_REFRESH' }, '*');
        render(next);
      };
      list.appendChild(li);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  async function load() {
    const data = await chrome.storage.sync.get([pageKey()]);
    render(data[pageKey()] || []);
  }

  window.addEventListener('message', (ev) => {
    if (!ev.data) return;
    if (ev.data.type === 'SB_SIDEBAR_RENDER') {
      render(ev.data.notes || []);
    }
  });

  await load();
})();
