// content.js
// Minimal annotation UI + AI hookup + Minimize toggle (bottom-right)
// Requires: background.js (MV3) and updated manifest with host_permissions for your backend.

(() => {
  if (window.__annotation_injected) return;
  window.__annotation_injected = true;

  // ---------- Storage helpers ----------
  const keyForPage = () => `annotations|${location.href}`;
  const MIN_KEY = `annotations|minimized|${location.href}`;

  function getAnnotations() {
    try {
      return JSON.parse(localStorage.getItem(keyForPage()) || "[]");
    } catch (e) {
      console.error("[annotations] parse error", e);
      return [];
    }
  }

  function setAnnotations(all) {
    try {
      localStorage.setItem(keyForPage(), JSON.stringify(all));
      window.dispatchEvent(new Event("annotationsUpdated"));
    } catch (e) {
      console.error("[annotations] set error", e);
    }
  }

  function clearAnnotations() {
    try {
      localStorage.removeItem(keyForPage());
      window.dispatchEvent(new Event("annotationsUpdated"));
    } catch (e) {
      console.error("[annotations] clear error", e);
    }
  }

  function getMinimized() {
    try { return localStorage.getItem(MIN_KEY) === "1"; } catch { return false; }
  }
  function setMinimized(on) {
    try { localStorage.setItem(MIN_KEY, on ? "1" : "0"); } catch {}
  }

  // ---------- Utilities ----------
  const escapeHtml = (s = "") =>
    s
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  function nowIso() {
    try { return new Date().toISOString(); } catch { return String(Date.now()); }
  }

  function getSelectionText() {
    try { return String(window.getSelection?.().toString() || ""); } catch { return ""; }
  }

  // Ask background to screenshot + call backend, return {ok, result|error}
  async function saveAnnotationAndAskAI({ comment, question, selectionText }) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            type: "SAVE_ANNOTATION_WITH_AI",
            question: question ?? comment ?? "",
            pageUrl: location.href,
            selection: selectionText || ""
          },
          (resp) => {
            if (!resp) {
              resolve({ ok: false, error: "No response from background." });
            } else {
              resolve(resp);
            }
          }
        );
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
  }

  // Core save: persist locally immediately, then enrich with AI results
  async function saveAnnotation(a) {
    const all = getAnnotations();
    const idx = all.length;

    const record = {
      id: crypto.randomUUID(),
      pageUrl: location.href,
      highlightedText: a.highlightedText || "",
      comment: a.comment || "",
      createdAt: nowIso(),
      status: "processing", // processing | done | error
      tldr: null,
      answer: null,
      error: null
    };

    all.push(record);
    setAnnotations(all);
    renderList();

    // Kick off AI call
    const resp = await saveAnnotationAndAskAI({
      comment: record.comment,
      question: record.comment,
      selectionText: record.highlightedText
    });

    const latest = getAnnotations();
    const current = latest[idx];
    if (!current) return; // page reload, etc.

    if (!resp?.ok) {
      current.status = "error";
      current.error = resp?.error || "Unknown error from background/AI.";
    } else {
      const { tldr, answer } = resp.result || {};
      current.status = "done";
      current.tldr = tldr || "";
      current.answer = answer || "";
      current.error = null;
    }
    latest[idx] = current;
    setAnnotations(latest);
    renderList();
  }

  // ---------- UI injection ----------
  const style = document.createElement("style");
  style.textContent = `
    .annotation-sidebar {
      position: fixed;
      top: 16px;
      right: 16px;
      width: 360px;
      max-height: 85vh;
      overflow: auto;
      z-index: 2147483647;
      background: #0b0b0bd9;
      backdrop-filter: blur(6px);
      color: #fff;
      font: 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji";
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      box-shadow: 0 8px 28px rgba(0,0,0,.35);
      transition: transform .25s ease, opacity .2s ease;
    }
    .annotation-sidebar.ann-min {
      transform: translateX(calc(100% + 24px));
      opacity: 0.6;
      pointer-events: none; /* panel content not interactive when minimized */
    }
    .ann-head {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px; border-bottom: 1px solid #222;
    }
    .ann-title { font-weight: 600; font-size: 14px; flex: 1; }
    .ann-btn {
      appearance: none; border: 1px solid #3a3a3a; background: #151515; color: #eee;
      padding: 6px 10px; border-radius: 8px; cursor: pointer;
    }
    .ann-btn:hover { background:#1b1b1b; }
    .ann-body { padding: 10px 12px; display: grid; gap: 8px; }
    .ann-input, .ann-textarea {
      width: 100%; border: 1px solid #333; background:#0e0e0e; color:#eee;
      border-radius: 8px; padding: 8px 10px;
    }
    .ann-textarea { min-height: 64px; resize: vertical; }
    .ann-list { display: grid; gap: 10px; margin-top: 6px; }
    .ann-card {
      border: 1px solid #272727; border-radius: 10px; background:#101010; padding: 8px 10px;
    }
    .ann-meta { opacity:.7; font-size: 12px; margin-bottom: 4px; }
    .ann-hlt { background: #1d2a12; border: 1px solid #2e4b22; padding: 6px; border-radius: 6px; white-space: pre-wrap; }
    .ann-comment { margin-top: 6px; white-space: pre-wrap; }
    .ann-kv { margin-top: 6px; font-size: 12px; }
    .ann-kv b { opacity:.9; }
    .ann-status { font-size: 12px; opacity:.75; margin-top: 6px; }
    .ann-hr { height:1px; background:#222; border:0; margin:8px 0; }
    .ann-actions { display: flex; gap: 8px; }
    .ann-danger { border-color:#643; background:#2a0f0f; }
    .ann-danger:hover { background:#361212; }

    /* Floating minimize / expand button (bottom-right) */
    .ann-fab {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      width: 46px;
      height: 46px;
      border-radius: 50%;
      border: 1px solid #2a2a2a;
      background: #111;
      color: #f6f6f6;
      font-size: 20px;
      display: grid;
      place-items: center;
      cursor: pointer;
      box-shadow: 0 6px 20px rgba(0,0,0,.35);
      transition: transform .15s ease, background .15s ease;
    }
    .ann-fab:hover { background:#181818; transform: translateY(-1px); }
    .ann-fab:active { transform: translateY(0); }
    .ann-fab[aria-pressed="true"] { background:#151515; }
  `;
  document.documentElement.appendChild(style);

  // Sidebar
  const root = document.createElement("div");
  root.className = "annotation-sidebar";
  root.innerHTML = `
    <div class="ann-head">
      <div class="ann-title">Page Annotations</div>
      <button class="ann-btn" id="ann-refresh">Refresh</button>
      <button class="ann-btn ann-danger" id="ann-clear">Clear</button>
    </div>
    <div class="ann-body">
      <div>
        <div style="font-weight:600; margin-bottom:6px;">Selection (auto-filled)</div>
        <textarea class="ann-textarea" id="ann-selection" placeholder="Select text on the page; this will capture automatically..."></textarea>
      </div>
      <div>
        <div style="font-weight:600; margin-bottom:6px;">Comment / Question</div>
        <textarea class="ann-textarea" id="ann-comment" placeholder="Ask a question or leave a note. This will be sent to AI with a screenshot."></textarea>
      </div>
      <div class="ann-actions">
        <button class="ann-btn" id="ann-save">Save</button>
      </div>
      <hr class="ann-hr"/>
      <div style="font-weight:600;">Saved</div>
      <div class="ann-list" id="ann-list"></div>
    </div>
  `;
  document.documentElement.appendChild(root);

  // Floating Action Button (minimize / expand)
  const fab = document.createElement("button");
  fab.className = "ann-fab";
  fab.setAttribute("type", "button");
  fab.setAttribute("title", "Toggle Annotations");
  fab.setAttribute("aria-pressed", getMinimized() ? "true" : "false");
  // Icons: ▣ (expand) / ▪ (min) – or use ▾/▴. We'll toggle dynamically.
  fab.textContent = getMinimized() ? "▣" : "▪";
  document.documentElement.appendChild(fab);

  function applyMinimizedUI(min) {
    if (min) {
      root.classList.add("ann-min");
      fab.setAttribute("aria-pressed", "true");
      fab.textContent = "▣"; // expand icon
    } else {
      root.classList.remove("ann-min");
      fab.setAttribute("aria-pressed", "false");
      fab.textContent = "▪"; // minimize icon
    }
  }
  applyMinimizedUI(getMinimized());

  // ---------- UI wiring ----------
  const $ = (sel) => root.querySelector(sel);
  const selEl = $("#ann-selection");
  const commentEl = $("#ann-comment");
  const listEl = $("#ann-list");

  $("#ann-refresh").addEventListener("click", renderList);
  $("#ann-clear").addEventListener("click", () => {
    if (confirm("Clear all annotations for this page?")) {
      clearAnnotations();
      renderList();
    }
  });

  $("#ann-save").addEventListener("click", async () => {
    const highlightedText = selEl.value.trim();
    const comment = commentEl.value.trim();

    if (!comment && !highlightedText) {
      alert("Add a comment or highlight text before saving.");
      return;
    }
    await saveAnnotation({ highlightedText, comment });
  });

  // Minimize/Expand toggle
  fab.addEventListener("click", () => {
    const next = !getMinimized();
    setMinimized(next);
    applyMinimizedUI(next);
  });

  // Keep the selection box in sync when user selects text on page
  document.addEventListener("selectionchange", () => {
    const s = getSelectionText();
    if (s) selEl.value = s;
  });

  // Re-render when storage changes (same page)
  window.addEventListener("annotationsUpdated", () => renderList());

  // ---------- Render ----------
  function renderList() {
    const data = getAnnotations();
    listEl.innerHTML = "";
    if (!data.length) {
      listEl.innerHTML = `<div style="opacity:.7;">No annotations yet.</div>`;
      return;
    }

    for (const ann of data) {
      const hlt = ann.highlightedText ? `
        <div class="ann-hlt"><b>Highlighted:</b>\n${escapeHtml(ann.highlightedText)}</div>
      ` : "";

      const tldrHtml = ann.tldr
        ? `<div class="ann-kv"><b>TL;DR:</b> ${escapeHtml(ann.tldr)}</div>`
        : "";

      const answerHtml = ann.answer
        ? `<div class="ann-kv"><b>Answer:</b> ${escapeHtml(ann.answer)}</div>`
        : "";

      const statusHtml =
        ann.status === "processing"
          ? `<div class="ann-status">⏳ Processing with AI…</div>`
          : ann.status === "error"
          ? `<div class="ann-status">❌ ${escapeHtml(ann.error || "Error")}</div>`
          : "";

      const card = document.createElement("div");
      card.className = "ann-card";
      card.innerHTML = `
        <div class="ann-meta">${escapeHtml(ann.createdAt || "")}</div>
        ${hlt}
        <div class="ann-comment"><b>Comment:</b>\n${escapeHtml(ann.comment || "")}</div>
        ${tldrHtml}
        ${answerHtml}
        ${statusHtml}
      `;
      listEl.appendChild(card);
    }
  }

  // Initial render
  renderList();
})();
