function sendToActiveTab(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, message);
  });
}

document.getElementById('toggle').addEventListener('click', () => {
  sendToActiveTab({ type: 'SB_TOGGLE_SIDEBAR' });
});

document.getElementById('add').addEventListener('click', () => {
  // Just simulate Alt+H workflow by asking content script to refresh (selection handling stays in page)
  sendToActiveTab({ type: 'SB_REFRESH' });
  window.close();
});
