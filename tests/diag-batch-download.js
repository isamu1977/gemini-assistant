
// Paste this in the Sidepanel DevTools console (right-click sidepanel -> Inspect
// OR  Extensions -> Gemini Assistant -> service worker -> right-click -> Inspect,
// then switch to the "Side Panel" frame if not already there).
//
// It runs the EXACT pipeline that Generate All Pending would run, but in
// micro-mode: only the first pending task, no second iteration. It traces every
// step of the download claim -> click -> blob fallback -> SW state machine.
// Output is in the sidepanel log (workflow-log UI section) AND in the console.

(async function diagnoseBatchDownload() {
  if (typeof window === 'undefined') { console.log('NOT IN BROWSER'); return; }
  if (typeof orchestrator === 'undefined' || !orchestrator) {
    console.log('[diag] orchestrator not yet initialized');
    return;
  }
  if (!state.source || !state.source.project) {
    console.log('[diag] no project loaded — click Generate All once manually first');
    return;
  }

  // Helper to capture the orchestrator download slot
  const snap = () => JSON.parse(JSON.stringify(orchestrator.state.download || {}));
  console.log('[diag] start:', {
    executionId: orchestrator.state.executionId,
    phase: orchestrator.state.phase,
    batchActive: orchestrator.state.batch?.active,
    downloadSlot: snap(),
  });

  // Inspect the active tab
  const tab = await chrome.tabs.query({ active: true, currentWindow: true });
  console.log('[diag] active tab:', tab[0]?.id, tab[0]?.url);

  // Verify SW listeners
  const probe = await new Promise(r => chrome.runtime.sendMessage(
    { type: 'GEMINI_ASSISTANT_DOWNLOAD_PROBE' }, r));
  console.log('[diag] SW registration:', probe);

  // Check page-side capability
  const ping = await sendToGemini('GEMINI_ASSISTANT_PING');
  console.log('[diag] content script ping:', ping);

  // Walk the buttons status
  const buttons = {
    prepare: prepareTaskBtn?.disabled,
    generate: generateTaskBtn?.disabled,
    retryDownload: retryDownloadBtn?.hidden,
    retryGenerate: retryGenerateBtn?.hidden,
    resetPrep: resetPrepBtn?.hidden,
  };
  console.log('[diag] buttons:', buttons);
})();
