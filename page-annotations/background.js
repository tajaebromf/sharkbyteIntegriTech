// background.js (MV3 service worker)

async function captureVisibleTabAsDataURL(windowId = undefined) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.captureVisibleTab(
        windowId,
        { format: "png" },
        (dataUrl) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(dataUrl);
          }
        }
      );
    } catch (e) {
      reject(e);
    }
  });
}

async function postAnnotate({ imageDataUrl, question, pageUrl, selectionText }) {
  // Convert data URL -> raw base64 without prefix
  const base64 = imageDataUrl.replace(/^data:image\/\w+;base64,/, "");

  const payload = {
    image_base64: base64,
    question: question || "",
    page_url: pageUrl || "",
    selection: selectionText || ""
  };

  const res = await fetch("http://127.0.0.1:8000/annotate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Backend error ${res.status}: ${text}`);
  }
  return res.json();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "SAVE_ANNOTATION_WITH_AI") {
      try {
        // capture the active window's visible tab
        const imageDataUrl = await captureVisibleTabAsDataURL();

        const result = await postAnnotate({
          imageDataUrl,
          question: msg.question,
          pageUrl: msg.pageUrl,
          selectionText: msg.selection
        });

        sendResponse({ ok: true, result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    }
  })();

  // Keep the message channel open for the async response.
  return true;
});
