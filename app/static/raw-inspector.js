(function () {
  const list = document.getElementById('rawAcquisitionList');
  const detail = document.getElementById('rawAcquisitionDetail');
  const state = document.getElementById('rawAcquisitionState');
  if (!list || !detail || !state) return;

  function safeEnvelope(item) {
    return {
      id: item.id,
      source_id: item.source_id,
      method: item.method,
      requested_url: item.requested_url,
      final_url: item.final_url,
      started_at: item.started_at,
      completed_at: item.completed_at,
      status: item.status,
      http_status: item.http_status,
      content_type: item.content_type,
      content_sha256: item.content_sha256,
      error_type: item.error_type,
      error_message: item.error_message,
      duration_ms: item.duration_ms,
      metadata: item.metadata || {},
    };
  }

  function select(item) {
    detail.textContent = JSON.stringify(safeEnvelope(item), null, 2);
    detail.dataset.acquisitionId = item.id || '';
  }

  async function refreshRawAcquisitions() {
    state.textContent = 'Loading raw acquisition envelopes…';
    try {
      const response = await fetch('/api/v1/acquisitions?limit=100', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rows = await response.json();
      list.replaceChildren();
      for (const item of rows) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'raw-acquisition-item';
        const completed = item.completed_at ? new Date(item.completed_at).toLocaleString() : 'unknown time';
        button.textContent = `${item.source_id || 'unknown source'} · ${item.status || 'unknown'} · ${completed}`;
        button.addEventListener('click', () => select(item));
        list.appendChild(button);
      }
      if (rows.length) select(rows[0]);
      else detail.textContent = 'No persisted acquisition envelopes.';
      state.textContent = `${rows.length} persisted acquisition envelope(s). Source response bodies are not rendered here.`;
    } catch (error) {
      state.textContent = `Raw acquisition view unavailable: ${error.message}`;
      detail.textContent = 'No acquisition selected.';
    }
  }

  window.refreshRawAcquisitions = refreshRawAcquisitions;
  refreshRawAcquisitions();
})();
