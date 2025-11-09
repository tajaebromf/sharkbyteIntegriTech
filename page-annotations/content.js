// content.js
// Annotation UI + AI hookup + Text highlighting with robust text-quote anchoring
// This uses text-based anchoring instead of fragile XPath

(() => {
  if (window.__annotation_injected) return;
  window.__annotation_injected = true;

  // ---------- Storage helpers ----------
  const keyForPage = () => `annotations|${location.href}`;
  const MIN_KEY = `annotations|minimized|${location.href}`;
  const HIGHLIGHTS_KEY = `highlights|${location.href}`;

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

  function getHighlights() {
    try {
      return JSON.parse(localStorage.getItem(HIGHLIGHTS_KEY) || "[]");
    } catch (e) {
      console.error("[highlights] parse error", e);
      return [];
    }
  }

  function setHighlights(highlights) {
    try {
      localStorage.setItem(HIGHLIGHTS_KEY, JSON.stringify(highlights));
    } catch (e) {
      console.error("[highlights] set error", e);
    }
  }

  function clearHighlights() {
    try {
      localStorage.removeItem(HIGHLIGHTS_KEY);
    } catch (e) {
      console.error("[highlights] clear error", e);
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

  let highlightColor = '#ffff00';

  // ---------- Text Quote Anchoring System ----------
  // This is a simplified implementation of the text-quote anchoring strategy
  // Similar to what Hypothesis and Chrome's "link to text" use

  /**
   * Extract text content from a node and its descendants
   */
  function getTextContent(node) {
    const walker = document.createTreeWalker(
      node,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );
    
    let text = '';
    let currentNode;
    while (currentNode = walker.nextNode()) {
      text += currentNode.textContent;
    }
    return text;
  }

  /**
   * Get surrounding text context for a range
   */
  function getContext(range, contextLength = 32) {
    const root = document.body;
    const rootText = getTextContent(root);
    
    // Find the exact text in the full document
    const exactText = range.toString();
    
    // Create a temporary range to get position in document
    const tempRange = document.createRange();
    tempRange.selectNodeContents(root);
    tempRange.setEnd(range.startContainer, range.startOffset);
    const textBefore = tempRange.toString();
    
    // Get prefix and suffix
    const startPos = textBefore.length;
    const endPos = startPos + exactText.length;
    
    const prefix = rootText.substring(Math.max(0, startPos - contextLength), startPos);
    const suffix = rootText.substring(endPos, Math.min(rootText.length, endPos + contextLength));
    
    return { prefix, suffix };
  }

  /**
   * Create a text quote anchor from a range
   */
  function createTextQuoteAnchor(range) {
    const exact = range.toString();
    const { prefix, suffix } = getContext(range);
    
    return {
      type: 'TextQuoteSelector',
      exact,
      prefix,
      suffix
    };
  }

  /**
   * Find text in document using exact match with context
   */
  function findTextWithContext(exact, prefix, suffix) {
    const root = document.body;
    const fullText = getTextContent(root);
    
    // Try to find with full context first
    const searchText = prefix + exact + suffix;
    let startIndex = fullText.indexOf(searchText);
    
    if (startIndex !== -1) {
      startIndex += prefix.length;
      return { startIndex, endIndex: startIndex + exact.length };
    }
    
    // Fall back to just exact match
    startIndex = fullText.indexOf(exact);
    if (startIndex !== -1) {
      return { startIndex, endIndex: startIndex + exact.length };
    }
    
    // Fuzzy match as last resort
    const words = exact.split(/\s+/).filter(w => w.length > 3);
    if (words.length > 0) {
      const firstWord = words[0];
      startIndex = fullText.indexOf(firstWord);
      if (startIndex !== -1) {
        // Try to find approximate match
        const endIndex = startIndex + exact.length;
        if (endIndex <= fullText.length) {
          return { startIndex, endIndex };
        }
      }
    }
    
    return null;
  }

  /**
   * Convert text position to DOM Range
   */
  function textPositionToRange(startIndex, endIndex) {
    const root = document.body;
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );
    
    let currentPos = 0;
    let startNode = null;
    let startOffset = 0;
    let endNode = null;
    let endOffset = 0;
    
    let node;
    while (node = walker.nextNode()) {
      const nodeLength = node.textContent.length;
      const nodeEnd = currentPos + nodeLength;
      
      // Find start
      if (startNode === null && startIndex >= currentPos && startIndex <= nodeEnd) {
        startNode = node;
        startOffset = startIndex - currentPos;
      }
      
      // Find end
      if (endIndex >= currentPos && endIndex <= nodeEnd) {
        endNode = node;
        endOffset = endIndex - currentPos;
        break;
      }
      
      currentPos = nodeEnd;
    }
    
    if (!startNode || !endNode) {
      return null;
    }
    
    const range = document.createRange();
    try {
      range.setStart(startNode, Math.min(startOffset, startNode.textContent.length));
      range.setEnd(endNode, Math.min(endOffset, endNode.textContent.length));
      return range;
    } catch (e) {
      console.error("[highlights] Failed to create range", e);
      return null;
    }
  }

  /**
   * Resolve a text quote anchor back to a Range
   */
  function resolveTextQuoteAnchor(anchor) {
    const position = findTextWithContext(anchor.exact, anchor.prefix, anchor.suffix);
    if (!position) {
      console.warn("[highlights] Could not find text:", anchor.exact.substring(0, 50));
      return null;
    }
    
    return textPositionToRange(position.startIndex, position.endIndex);
  }

  // ---------- Highlight Management ----------

  /**
   * Save highlight with text-quote anchor
   */
  function saveHighlight(range, text) {
    const anchor = createTextQuoteAnchor(range);
    
    const highlight = {
      id: crypto.randomUUID(),
      text: text,
      anchor: anchor,
      createdAt: nowIso()
    };
    
    const highlights = getHighlights();
    highlights.push(highlight);
    setHighlights(highlights);
    
    return highlight;
  }

  /**
   * Apply a highlight to the DOM
   */
  function applyHighlight(highlight) {
    try {
      const range = resolveTextQuoteAnchor(highlight.anchor);
      
      if (!range) {
        console.warn("[highlights] Could not resolve anchor for highlight", highlight.id);
        return false;
      }
      
      // Check if this text is already highlighted
      const existingHighlight = document.querySelector(`[data-highlight-id="${highlight.id}"]`);
      if (existingHighlight) {
        return true; // Already highlighted
      }
      
      // Wrap the range in a highlight span
      const span = document.createElement('mark');
      span.className = 'annotation-highlight';
      span.dataset.highlightId = highlight.id;
      span.style.backgroundColor = highlightColor;
      span.style.cursor = 'pointer';
      span.title = `Highlighted: ${highlight.text.substring(0, 100)}...`;
      
      try {
        range.surroundContents(span);
        return true;
      } catch (e) {
        // If surroundContents fails (crosses element boundaries), use extraction method
        try {
          const contents = range.extractContents();
          span.appendChild(contents);
          range.insertNode(span);
          return true;
        } catch (e2) {
          console.error("[highlights] Failed to apply highlight", highlight.id, e2);
          return false;
        }
      }
    } catch (e) {
      console.error("[highlights] Failed to apply highlight", highlight.id, e);
      return false;
    }
  }

  /**
   * Remove all highlight spans from the page
   */
  function clearHighlightSpans() {
    const spans = document.querySelectorAll('.annotation-highlight');
    spans.forEach(span => {
      const parent = span.parentNode;
      if (parent) {
        while (span.firstChild) {
          parent.insertBefore(span.firstChild, span);
        }
        parent.removeChild(span);
        parent.normalize(); // Merge adjacent text nodes
      }
    });
  }

  /**
   * Restore all saved highlights
   */
  function restoreHighlights() {
    clearHighlightSpans();
    const highlights = getHighlights();
    let successCount = 0;
    highlights.forEach(h => {
      if (applyHighlight(h)) {
        successCount++;
      }
    });
    console.log(`[highlights] Restored ${successCount}/${highlights.length} highlights`);
  }

  /**
   * Highlight the current selection
   */
  function highlightSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      return null;
    }
    
    const range = selection.getRangeAt(0);
    const text = selection.toString();
    
    // Save the highlight data
    const highlight = saveHighlight(range, text);
    
    // Apply the highlight visually
    applyHighlight(highlight);
    
    // Clear the selection
    selection.removeAllRanges();
    
    return highlight;
  }

  // ---------- AI Integration ----------

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
          (response) => {
            if (chrome.runtime.lastError) {
              const errorMessage = chrome.runtime.lastError.message;
              if (errorMessage.includes("Extension context invalidated") || 
                  errorMessage.includes("message port closed")) {
                resolve({ 
                  ok: false, 
                  error: "Extension was reloaded. Please refresh this page to continue using annotations." 
                });
              } else {
                resolve({ 
                  ok: false, 
                  error: `Extension error: ${errorMessage}` 
                });
              }
              return;
            }
            
            if (!response) {
              resolve({ ok: false, error: "No response from background script." });
              return;
            }
            
            resolve(response);
          }
        );
      } catch (error) {
        resolve({ ok: false, error: `Failed to send message: ${String(error)}` });
      }
    });
  }

  async function saveAnnotation(a) {
    const all = getAnnotations();
    const idx = all.length;

    const record = {
      id: crypto.randomUUID(),
      pageUrl: location.href,
      highlightedText: a.highlightedText || "",
      comment: a.comment || "",
      createdAt: nowIso(),
      status: "processing",
      tldr: null,
      answer: null,
      error: null
    };

    all.push(record);
    setAnnotations(all);
    renderList();

    showThinkingState();

    const resp = await saveAnnotationAndAskAI({
      comment: record.comment,
      question: record.comment,
      selectionText: record.highlightedText
    });

    restoreNormalButtonState();

    const latest = getAnnotations();
    const current = latest[idx];
    if (!current) return;

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
    .annotation-highlight {
      background-color: ${highlightColor};
      cursor: pointer;
      transition: background-color 0.2s ease;
    }
    .annotation-highlight:hover {
      background-color: #ffeb3b;
    }
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
      pointer-events: none;
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
      padding: 8px;
      display: grid;
      place-items: center;
      cursor: pointer;
      box-shadow: 0 6px 20px rgba(0,0,0,.35);
      transition: transform .15s ease, background .15s ease;
      overflow: hidden;
    }
    .ann-fab:hover { background:#181818; transform: translateY(-1px); }
    .ann-fab:active { transform: translateY(0); }
    .ann-fab[aria-pressed="true"] { background:#151515; }
    .ann-fab img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }
  `;
  document.documentElement.appendChild(style);

  // Sidebar
  const root = document.createElement("div");
  root.className = "annotation-sidebar";
  root.innerHTML = `
    <div class="ann-head">
      <div class="ann-title">Browser Buddy</div>
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
        <button class="ann-btn" id="ann-highlight">Highlight</button>
      </div>
      <hr class="ann-hr"/>
      <div style="font-weight:600;">Saved</div>
      <div class="ann-list" id="ann-list"></div>
    </div>
  `;
  document.documentElement.appendChild(root);

  const toggleButton = document.createElement("button");
  toggleButton.className = "ann-fab";
  toggleButton.setAttribute("type", "button");
  toggleButton.setAttribute("title", "Toggle Annotations");
  toggleButton.setAttribute("aria-pressed", getMinimized() ? "true" : "false");
  
  const toggleButtonImage = document.createElement("img");
  toggleButtonImage.alt = "Toggle Annotations";
  
  const imagePathWhenSidebarIsOpen = chrome.runtime.getURL("images/Sam-Speaks.png");
  const imagePathWhenSidebarIsMinimized = chrome.runtime.getURL("images/Sam-Sleep.png");
  const imagePathWhenThinking = chrome.runtime.getURL("images/Sam-thinks.png");
  
  toggleButtonImage.src = imagePathWhenSidebarIsOpen;
  toggleButton.appendChild(toggleButtonImage);
  document.documentElement.appendChild(toggleButton);

  function updateSidebarMinimizedState(isMinimized) {
    if (isMinimized) {
      root.classList.add("ann-min");
      toggleButton.setAttribute("aria-pressed", "true");
      toggleButtonImage.src = imagePathWhenSidebarIsMinimized;
    } else {
      root.classList.remove("ann-min");
      toggleButton.setAttribute("aria-pressed", "false");
      toggleButtonImage.src = imagePathWhenSidebarIsOpen;
    }
  }
  
  function showThinkingState() {
    toggleButtonImage.src = imagePathWhenThinking;
  }
  
  function restoreNormalButtonState() {
    const isCurrentlyMinimized = getMinimized();
    if (isCurrentlyMinimized) {
      toggleButtonImage.src = imagePathWhenSidebarIsMinimized;
    } else {
      toggleButtonImage.src = imagePathWhenSidebarIsOpen;
    }
  }
  
  updateSidebarMinimizedState(getMinimized());

  // ---------- UI wiring ----------
  const $ = (sel) => root.querySelector(sel);
  const selEl = $("#ann-selection");
  const commentEl = $("#ann-comment");
  const listEl = $("#ann-list");

  $("#ann-refresh").addEventListener("click", () => {
    restoreHighlights();
    renderList();
  });

  $("#ann-clear").addEventListener("click", () => {
    if (confirm("Clear all annotations and highlights for this page?")) {
      clearAnnotations();
      clearHighlights();
      clearHighlightSpans();
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

  $("#ann-highlight").addEventListener("click", () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      alert("Please select some text to highlight.");
      return;
    }
    
    highlightSelection();
    alert("Text highlighted! It will remain highlighted on this page.");
  });

  toggleButton.addEventListener("click", () => {
    const newMinimizedState = !getMinimized();
    setMinimized(newMinimizedState);
    updateSidebarMinimizedState(newMinimizedState);
  });

  document.addEventListener("selectionchange", () => {
    const s = getSelectionText();
    if (s) selEl.value = s;
  });

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

  // Initial render and restore highlights
  renderList();
  
  // Restore highlights after a short delay to ensure DOM is ready
  setTimeout(() => {
    restoreHighlights();
  }, 100);
  
  // Re-apply highlights when the page content changes (for dynamic sites)
  const observer = new MutationObserver(() => {
    clearTimeout(observer.timer);
    observer.timer = setTimeout(() => {
      const highlights = getHighlights();
      const existingHighlights = document.querySelectorAll('.annotation-highlight');
      
      // Only restore if we have saved highlights but fewer visible ones
      if (highlights.length > 0 && existingHighlights.length < highlights.length) {
        console.log("[highlights] DOM changed, restoring highlights");
        restoreHighlights();
      }
    }, 1000); // Increased debounce time
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
})();