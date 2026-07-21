/**
 * Custom Dashboard Engine
 * Drag-and-drop dashboard with CSS Grid positioning
 * Requirements: 27.1, 27.2, 27.3, 27.4, 27.5, 27.6, 27.7, 27.8, 27.9
 */

(function () {
  'use strict';

  // Constants
  const MAX_DASHBOARDS = 10;
  const MAX_WIDGETS = 20;
  const GRID_COLUMNS = 12;
  const MAX_COL_SPAN = 12;
  const MAX_ROW_SPAN = 4;
  const MIN_COL_SPAN = 1;
  const MIN_ROW_SPAN = 1;
  const MAX_NAME_LENGTH = 64;

  const WIDGET_TYPES = [
    'monitor_status',
    'response_chart',
    'heatmap',
    'apdex',
    'sla',
    'error_rate',
    'comparison'
  ];

  const WIDGET_LABELS = {
    monitor_status: 'Monitor Status',
    response_chart: 'Response Chart',
    heatmap: 'Uptime Heatmap',
    apdex: 'Apdex Score',
    sla: 'SLA Status',
    error_rate: 'Error Rate',
    comparison: 'Comparison Chart'
  };

  // State
  let dashboards = [];
  let activeDashboardId = null;
  let widgets = [];
  let draggedWidgetId = null;
  let unsavedLayout = null;
  let monitors = [];
  let suppressSelectorChange = false;

  // Default dashboard layout
  const DEFAULT_DASHBOARD = {
    name: 'Default Dashboard',
    widgets: [
      { widget_type: 'monitor_status', config: { monitor_id: null }, col_start: 1, col_span: 4, row_start: 1, row_span: 1 },
      { widget_type: 'response_chart', config: { monitor_id: null }, col_start: 5, col_span: 8, row_start: 1, row_span: 2 },
      { widget_type: 'heatmap', config: { monitor_id: null }, col_start: 1, col_span: 4, row_start: 2, row_span: 1 },
      { widget_type: 'apdex', config: { monitor_id: null }, col_start: 1, col_span: 3, row_start: 3, row_span: 1 },
      { widget_type: 'sla', config: { monitor_id: null }, col_start: 4, col_span: 3, row_start: 3, row_span: 1 },
      { widget_type: 'error_rate', config: { monitor_id: null }, col_start: 7, col_span: 6, row_start: 3, row_span: 1 }
    ]
  };

  // ─── API Helpers ───────────────────────────────────────────────────

  function getAuthHeaders() {
    const token = localStorage.getItem('rx-monitor-token');
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }
    return headers;
  }

  async function apiGet(url) {
    const res = await fetch(url, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async function apiPost(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async function apiPut(url, body) {
    const res = await fetch(url, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async function apiDelete(url) {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  // ─── Validation ────────────────────────────────────────────────────

  function validateDashboardName(name) {
    if (!name || typeof name !== 'string') return 'Dashboard name is required.';
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > MAX_NAME_LENGTH) {
      return 'Dashboard name must be between 1 and ' + MAX_NAME_LENGTH + ' characters.';
    }
    const duplicate = dashboards.find(
      d => d.name.toLowerCase() === trimmed.toLowerCase() && d.id !== activeDashboardId
    );
    if (duplicate) return 'A dashboard with this name already exists.';
    return null;
  }

  function validateWidgetPosition(widget) {
    if (widget.col_start < 1 || widget.col_start > GRID_COLUMNS) return false;
    if (widget.col_span < MIN_COL_SPAN || widget.col_span > MAX_COL_SPAN) return false;
    if (widget.row_span < MIN_ROW_SPAN || widget.row_span > MAX_ROW_SPAN) return false;
    if (widget.col_start + widget.col_span - 1 > GRID_COLUMNS) return false;
    return true;
  }

  function isValidWidgetType(type) {
    return WIDGET_TYPES.includes(type);
  }

  // ─── Data Loading ──────────────────────────────────────────────────

  async function loadMonitors() {
    try {
      monitors = await apiGet('/api/monitors');
    } catch (e) {
      monitors = [];
    }
  }

  async function loadDashboards() {
    try {
      dashboards = await apiGet('/api/dashboards');
    } catch (e) {
      dashboards = [];
    }
  }

  async function loadWidgets(dashboardId) {
    try {
      widgets = await apiGet('/api/dashboards/' + dashboardId + '/widgets');
    } catch (e) {
      widgets = [];
    }
  }

  function isMonitorAvailable(monitorId) {
    if (!monitorId) return false;
    return monitors.some(m => m.id === monitorId);
  }

  function areMonitorsAvailable(monitorIds) {
    if (!monitorIds || !Array.isArray(monitorIds) || monitorIds.length === 0) return false;
    return monitorIds.some(id => isMonitorAvailable(id));
  }

  // ─── Rendering ─────────────────────────────────────────────────────

  function getContainer() {
    return document.getElementById('custom-dashboard-container');
  }

  function renderDashboardSelector() {
    const container = getContainer();
    if (!container) return;

    suppressSelectorChange = true;

    const selectorEl = container.querySelector('.dashboard-selector') ||
      document.createElement('div');
    selectorEl.className = 'dashboard-selector';

    let optionsHtml = '';
    if (dashboards.length === 0) {
      optionsHtml = '<option value="">Default Dashboard</option>';
    } else {
      dashboards.forEach(d => {
        const selected = d.id === activeDashboardId ? ' selected' : '';
        optionsHtml += '<option value="' + d.id + '"' + selected + '>' +
          escapeHtml(d.name) + '</option>';
      });
    }

    selectorEl.innerHTML =
      '<div class="dashboard-toolbar">' +
        '<select class="dashboard-select" aria-label="Select dashboard">' +
        optionsHtml +
        '</select>' +
        '<button class="btn btn-sm dashboard-btn-new" title="New Dashboard"' +
        (dashboards.length >= MAX_DASHBOARDS ? ' disabled' : '') +
        '>+ New</button>' +
        '<button class="btn btn-sm dashboard-btn-rename" title="Rename Dashboard">✏️</button>' +
        '<button class="btn btn-sm dashboard-btn-delete" title="Delete Dashboard">🗑️</button>' +
        '<button class="btn btn-sm dashboard-btn-add-widget" title="Add Widget"' +
        (widgets.length >= MAX_WIDGETS ? ' disabled' : '') +
        '>+ Widget</button>' +
      '</div>';

    if (!container.querySelector('.dashboard-selector')) {
      container.prepend(selectorEl);
    }

    // Attach events
    const select = selectorEl.querySelector('.dashboard-select');
    select.addEventListener('change', function () {
      if (suppressSelectorChange) return;
      const id = this.value ? parseInt(this.value, 10) : null;
      switchDashboard(id);
    });

    selectorEl.querySelector('.dashboard-btn-new').addEventListener('click', createNewDashboard);
    selectorEl.querySelector('.dashboard-btn-rename').addEventListener('click', renameDashboard);
    selectorEl.querySelector('.dashboard-btn-delete').addEventListener('click', deleteDashboard);
    selectorEl.querySelector('.dashboard-btn-add-widget').addEventListener('click', openAddWidgetDialog);

    suppressSelectorChange = false;
  }

  function renderGrid() {
    const container = getContainer();
    if (!container) return;

    let gridEl = container.querySelector('.dashboard-grid');
    if (!gridEl) {
      gridEl = document.createElement('div');
      gridEl.className = 'dashboard-grid';
      container.appendChild(gridEl);
    }

    gridEl.style.display = 'grid';
    gridEl.style.gridTemplateColumns = 'repeat(' + GRID_COLUMNS + ', 1fr)';
    gridEl.style.gridAutoRows = 'minmax(120px, auto)';
    gridEl.style.gap = '12px';
    gridEl.style.padding = '16px 0';

    const activeWidgets = widgets.length > 0 ? widgets : (
      dashboards.length === 0 ? DEFAULT_DASHBOARD.widgets : []
    );

    if (activeWidgets.length === 0) {
      gridEl.innerHTML =
        '<div class="dashboard-empty-state" style="grid-column: 1 / -1; text-align: center; padding: 48px;">' +
          '<p style="font-size: 1.1rem; opacity: 0.7;">No widgets configured.</p>' +
          '<p style="opacity: 0.5;">Click "+ Widget" to add your first widget.</p>' +
        '</div>';
      return;
    }

    gridEl.innerHTML = activeWidgets.map(function (w, idx) {
      const widgetId = w.id || ('default-' + idx);
      const position = 'grid-column: ' + w.col_start + ' / span ' + w.col_span + '; ' +
        'grid-row: ' + w.row_start + ' / span ' + w.row_span + ';';
      const content = renderWidgetContent(w);

      return '<div class="dashboard-widget" ' +
        'data-widget-id="' + widgetId + '" ' +
        'draggable="true" ' +
        'style="' + position + '" ' +
        'role="article" ' +
        'aria-label="' + WIDGET_LABELS[w.widget_type] + ' widget">' +
        '<div class="widget-header">' +
          '<span class="widget-title">' + WIDGET_LABELS[w.widget_type] + '</span>' +
          '<button class="widget-btn-remove" data-widget-id="' + widgetId + '" ' +
            'title="Remove widget" aria-label="Remove widget">×</button>' +
        '</div>' +
        '<div class="widget-body">' + content + '</div>' +
      '</div>';
    }).join('');

    // Attach drag events
    gridEl.querySelectorAll('.dashboard-widget').forEach(function (el) {
      el.addEventListener('dragstart', handleDragStart);
      el.addEventListener('dragend', handleDragEnd);
    });

    gridEl.addEventListener('dragover', handleDragOver);
    gridEl.addEventListener('drop', handleDrop);

    // Attach remove widget events
    gridEl.querySelectorAll('.widget-btn-remove').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        const wId = this.getAttribute('data-widget-id');
        removeWidget(wId);
      });
    });
  }

  function renderWidgetContent(widget) {
    const config = typeof widget.config === 'string'
      ? JSON.parse(widget.config)
      : (widget.config || {});

    // Check data source availability
    if (widget.widget_type === 'comparison') {
      if (!areMonitorsAvailable(config.monitor_ids)) {
        return renderEmptyState('Data source monitors unavailable.');
      }
    } else {
      if (config.monitor_id && !isMonitorAvailable(config.monitor_id)) {
        return renderEmptyState('Data source monitor unavailable.');
      }
    }

    // Render placeholder content based on widget type
    switch (widget.widget_type) {
      case 'monitor_status':
        return renderMonitorStatusWidget(config);
      case 'response_chart':
        return renderResponseChartWidget(config);
      case 'heatmap':
        return renderHeatmapWidget(config);
      case 'apdex':
        return renderApdexWidget(config);
      case 'sla':
        return renderSlaWidget(config);
      case 'error_rate':
        return renderErrorRateWidget(config);
      case 'comparison':
        return renderComparisonWidget(config);
      default:
        return renderEmptyState('Unknown widget type.');
    }
  }

  function renderEmptyState(message) {
    return '<div class="widget-empty-state">' +
      '<p>' + escapeHtml(message) + '</p>' +
    '</div>';
  }

  function renderMonitorStatusWidget(config) {
    if (!config.monitor_id) return renderEmptyState('No monitor selected.');
    const monitor = monitors.find(m => m.id === config.monitor_id);
    if (!monitor) return renderEmptyState('Data source monitor unavailable.');
    const statusClass = (monitor.status || 'unknown').toLowerCase();
    return '<div class="widget-monitor-status">' +
      '<div class="status-indicator ' + statusClass + '">' + escapeHtml(monitor.status || 'N/A') + '</div>' +
      '<div class="monitor-name">' + escapeHtml(monitor.name) + '</div>' +
      '<div class="monitor-url">' + escapeHtml(monitor.url) + '</div>' +
    '</div>';
  }

  function renderResponseChartWidget(config) {
    if (!config.monitor_id) return renderEmptyState('No monitor selected.');
    return '<div class="widget-chart-placeholder" data-monitor-id="' + config.monitor_id + '">' +
      '<p>Response time chart</p>' +
      '<div class="chart-area" aria-label="Response time chart loading"></div>' +
    '</div>';
  }

  function renderHeatmapWidget(config) {
    if (!config.monitor_id) return renderEmptyState('No monitor selected.');
    return '<div class="widget-heatmap-placeholder" data-monitor-id="' + config.monitor_id + '">' +
      '<p>90-day uptime heatmap</p>' +
      '<div class="heatmap-area" aria-label="Heatmap loading"></div>' +
    '</div>';
  }

  function renderApdexWidget(config) {
    if (!config.monitor_id) return renderEmptyState('No monitor selected.');
    return '<div class="widget-apdex-placeholder" data-monitor-id="' + config.monitor_id + '">' +
      '<p>Apdex Score</p>' +
      '<div class="apdex-display">--</div>' +
    '</div>';
  }

  function renderSlaWidget(config) {
    if (!config.monitor_id) return renderEmptyState('No monitor selected.');
    return '<div class="widget-sla-placeholder" data-monitor-id="' + config.monitor_id + '">' +
      '<p>SLA Status</p>' +
      '<div class="sla-display">--</div>' +
    '</div>';
  }

  function renderErrorRateWidget(config) {
    if (!config.monitor_id) return renderEmptyState('No monitor selected.');
    return '<div class="widget-error-rate-placeholder" data-monitor-id="' + config.monitor_id + '">' +
      '<p>Error Rate</p>' +
      '<div class="error-rate-display">--</div>' +
    '</div>';
  }

  function renderComparisonWidget(config) {
    if (!config.monitor_ids || config.monitor_ids.length < 2) {
      return renderEmptyState('Select at least 2 monitors.');
    }
    return '<div class="widget-comparison-placeholder" data-monitor-ids="' +
      config.monitor_ids.join(',') + '">' +
      '<p>Comparison Chart</p>' +
      '<div class="comparison-area" aria-label="Comparison chart loading"></div>' +
    '</div>';
  }

  // ─── Drag and Drop ─────────────────────────────────────────────────

  function handleDragStart(e) {
    draggedWidgetId = this.getAttribute('data-widget-id');
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedWidgetId);
  }

  function handleDragEnd() {
    this.classList.remove('dragging');
    draggedWidgetId = null;
    // Remove any drop indicators
    const container = getContainer();
    if (container) {
      container.querySelectorAll('.drop-indicator').forEach(function (el) {
        el.remove();
      });
    }
  }

  function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }

  function handleDrop(e) {
    e.preventDefault();
    if (!draggedWidgetId) return;

    const gridEl = getContainer().querySelector('.dashboard-grid');
    if (!gridEl) return;

    // Calculate new grid position from drop coordinates
    const gridRect = gridEl.getBoundingClientRect();
    const colWidth = gridRect.width / GRID_COLUMNS;
    const rowHeight = 80; // Approximate row height in pixels

    const offsetX = e.clientX - gridRect.left;
    const offsetY = e.clientY - gridRect.top;

    const newColStart = Math.max(1, Math.min(GRID_COLUMNS, Math.ceil(offsetX / colWidth)));
    const newRowStart = Math.max(1, Math.ceil(offsetY / rowHeight));

    // Update widget position
    const widgetIdx = widgets.findIndex(function (w) {
      return String(w.id) === String(draggedWidgetId);
    });

    if (widgetIdx !== -1) {
      const widget = widgets[widgetIdx];
      // Clamp to grid boundaries
      const maxCol = GRID_COLUMNS - widget.col_span + 1;
      widget.col_start = Math.max(1, Math.min(maxCol, newColStart));
      widget.row_start = Math.max(1, newRowStart);

      if (validateWidgetPosition(widget)) {
        saveLayout();
        renderGrid();
      }
    }

    draggedWidgetId = null;
  }

  // ─── Dashboard CRUD ────────────────────────────────────────────────

  async function switchDashboard(dashboardId) {
    activeDashboardId = dashboardId;
    if (dashboardId) {
      localStorage.setItem('rx-dashboard-active', String(dashboardId));
      await loadWidgets(dashboardId);
    } else {
      localStorage.removeItem('rx-dashboard-active');
      widgets = [];
    }
    renderGrid();
  }

  async function createNewDashboard() {
    if (dashboards.length >= MAX_DASHBOARDS) {
      showError('Maximum of ' + MAX_DASHBOARDS + ' dashboards reached.');
      return;
    }

    const name = prompt('Enter dashboard name (1-64 characters):');
    if (!name) return;

    const error = validateDashboardName(name);
    if (error) {
      showError(error);
      return;
    }

    try {
      const result = await apiPost('/api/dashboards', { name: name.trim() });
      dashboards.push(result);
      activeDashboardId = result.id;
      widgets = [];
      renderDashboardSelector();
      renderGrid();
    } catch (e) {
      showError('Failed to create dashboard: ' + e.message);
    }
  }

  async function renameDashboard() {
    if (!activeDashboardId) {
      showError('Cannot rename the default dashboard.');
      return;
    }

    const current = dashboards.find(d => d.id === activeDashboardId);
    const name = prompt('Enter new name:', current ? current.name : '');
    if (!name) return;

    const error = validateDashboardName(name);
    if (error) {
      showError(error);
      return;
    }

    try {
      await apiPut('/api/dashboards/' + activeDashboardId, { name: name.trim() });
      const idx = dashboards.findIndex(d => d.id === activeDashboardId);
      if (idx !== -1) dashboards[idx].name = name.trim();
      renderDashboardSelector();
    } catch (e) {
      showError('Failed to rename dashboard: ' + e.message);
    }
  }

  async function deleteDashboard() {
    if (!activeDashboardId) {
      showError('Cannot delete the default dashboard.');
      return;
    }

    if (!confirm('Are you sure you want to delete this dashboard?')) return;

    try {
      await apiDelete('/api/dashboards/' + activeDashboardId);
      dashboards = dashboards.filter(d => d.id !== activeDashboardId);
      activeDashboardId = dashboards.length > 0 ? dashboards[0].id : null;
      if (activeDashboardId) {
        await loadWidgets(activeDashboardId);
      } else {
        widgets = [];
      }
      renderDashboardSelector();
      renderGrid();
    } catch (e) {
      showError('Failed to delete dashboard: ' + e.message);
    }
  }

  // ─── Widget CRUD ───────────────────────────────────────────────────

  function openAddWidgetDialog() {
    if (widgets.length >= MAX_WIDGETS) {
      showError('Maximum of ' + MAX_WIDGETS + ' widgets per dashboard.');
      return;
    }

    // Create a modal dialog for adding widgets
    const overlay = document.createElement('div');
    overlay.className = 'dashboard-modal-overlay';
    overlay.innerHTML = buildAddWidgetForm();
    document.body.appendChild(overlay);

    // Event handlers for the modal
    overlay.querySelector('.dashboard-modal-close').addEventListener('click', function () {
      overlay.remove();
    });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });

    const form = overlay.querySelector('.add-widget-form');
    const typeSelect = form.querySelector('[name="widget_type"]');
    const monitorSelect = form.querySelector('[name="monitor_id"]');
    const monitorMulti = form.querySelector('[name="monitor_ids"]');

    typeSelect.addEventListener('change', function () {
      if (this.value === 'comparison') {
        monitorSelect.parentElement.style.display = 'none';
        monitorMulti.parentElement.style.display = 'block';
      } else {
        monitorSelect.parentElement.style.display = 'block';
        monitorMulti.parentElement.style.display = 'none';
      }
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      const type = typeSelect.value;
      let config = {};

      if (type === 'comparison') {
        const selected = Array.from(monitorMulti.selectedOptions).map(o => parseInt(o.value, 10));
        if (selected.length < 2) {
          showError('Select at least 2 monitors for comparison.');
          return;
        }
        config = { monitor_ids: selected };
      } else {
        const monId = monitorSelect.value ? parseInt(monitorSelect.value, 10) : null;
        config = { monitor_id: monId };
      }

      addWidget(type, config);
      overlay.remove();
    });
  }

  function buildAddWidgetForm() {
    let monitorOptions = '<option value="">-- Select Monitor --</option>';
    monitors.forEach(function (m) {
      monitorOptions += '<option value="' + m.id + '">' + escapeHtml(m.name) + '</option>';
    });

    let multiOptions = '';
    monitors.forEach(function (m) {
      multiOptions += '<option value="' + m.id + '">' + escapeHtml(m.name) + '</option>';
    });

    let typeOptions = '';
    WIDGET_TYPES.forEach(function (t) {
      typeOptions += '<option value="' + t + '">' + WIDGET_LABELS[t] + '</option>';
    });

    return '<div class="dashboard-modal">' +
      '<div class="dashboard-modal-header">' +
        '<h3>Add Widget</h3>' +
        '<button class="dashboard-modal-close" aria-label="Close">×</button>' +
      '</div>' +
      '<form class="add-widget-form">' +
        '<div class="form-group">' +
          '<label for="widget-type-select">Widget Type</label>' +
          '<select name="widget_type" id="widget-type-select" required>' + typeOptions + '</select>' +
        '</div>' +
        '<div class="form-group">' +
          '<label for="widget-monitor-select">Monitor</label>' +
          '<select name="monitor_id" id="widget-monitor-select">' + monitorOptions + '</select>' +
        '</div>' +
        '<div class="form-group" style="display:none;">' +
          '<label for="widget-monitors-multi">Monitors (hold Ctrl/Cmd to multi-select)</label>' +
          '<select name="monitor_ids" id="widget-monitors-multi" multiple size="5">' +
            multiOptions +
          '</select>' +
        '</div>' +
        '<div class="form-group">' +
          '<button type="submit" class="btn btn-primary">Add Widget</button>' +
        '</div>' +
      '</form>' +
    '</div>';
  }

  async function addWidget(type, config) {
    if (!isValidWidgetType(type)) {
      showError('Invalid widget type.');
      return;
    }
    if (widgets.length >= MAX_WIDGETS) {
      showError('Maximum of ' + MAX_WIDGETS + ' widgets per dashboard.');
      return;
    }

    // Find next available grid position
    const position = findNextPosition();

    const widgetData = {
      widget_type: type,
      config: config,
      col_start: position.col_start,
      col_span: position.col_span,
      row_start: position.row_start,
      row_span: 1
    };

    if (!activeDashboardId) {
      // If on default dashboard, create a real one first
      try {
        const timestamp = Date.now().toString(36);
        const result = await apiPost('/api/dashboards', { name: 'My Dashboard ' + timestamp });
        dashboards.push(result);
        activeDashboardId = result.id;
        renderDashboardSelector();
      } catch (e) {
        showError('Failed to create dashboard: ' + e.message);
        return;
      }
    }

    try {
      const result = await apiPost('/api/dashboards/' + activeDashboardId + '/widgets', widgetData);
      widgets.push(result);
      renderGrid();
      // Update the add-widget button disabled state without full selector rebuild
      var addBtn = getContainer().querySelector('.dashboard-btn-add-widget');
      if (addBtn) addBtn.disabled = widgets.length >= MAX_WIDGETS;
    } catch (e) {
      showError('Failed to add widget: ' + e.message);
    }
  }

  async function removeWidget(widgetId) {
    if (String(widgetId).startsWith('default-')) {
      // Can't remove from default dashboard
      showError('Create a custom dashboard to manage widgets.');
      return;
    }

    if (!confirm('Remove this widget?')) return;

    try {
      await apiDelete('/api/dashboards/' + activeDashboardId + '/widgets/' + widgetId);
      widgets = widgets.filter(w => String(w.id) !== String(widgetId));
      renderGrid();
      // Update the add-widget button disabled state
      var addBtn = getContainer().querySelector('.dashboard-btn-add-widget');
      if (addBtn) addBtn.disabled = widgets.length >= MAX_WIDGETS;
    } catch (e) {
      showError('Failed to remove widget: ' + e.message);
    }
  }

  function findNextPosition() {
    if (widgets.length === 0) {
      return { col_start: 1, col_span: 4, row_start: 1 };
    }

    // Find the max row endpoint and place the new widget below all existing ones
    let maxRowEnd = 0;
    widgets.forEach(function (w) {
      var rowEnd = (parseInt(w.row_start) || 1) + (parseInt(w.row_span) || 1);
      if (rowEnd > maxRowEnd) maxRowEnd = rowEnd;
    });

    return { col_start: 1, col_span: 4, row_start: maxRowEnd };
  }

  // ─── Layout Persistence ─────────────────────────────────────────────

  async function saveLayout() {
    if (!activeDashboardId) return;

    const layout = widgets.map(function (w) {
      return {
        id: w.id,
        col_start: w.col_start,
        col_span: w.col_span,
        row_start: w.row_start,
        row_span: w.row_span
      };
    });

    // Store unsaved layout locally in case save fails (Req 27.8)
    unsavedLayout = layout;

    try {
      await apiPut('/api/dashboards/' + activeDashboardId + '/layout', { layout: layout });
      unsavedLayout = null;
    } catch (e) {
      showError('Failed to save layout. Your changes are preserved locally.');
      // Layout retained in client state per Req 27.8
    }
  }

  // ─── Utility Functions ─────────────────────────────────────────────

  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function showError(message) {
    // Use the app's toast if available, otherwise alert
    if (typeof showToast === 'function') {
      showToast(message, 'error');
    } else {
      var toastEl = document.getElementById('toast');
      if (toastEl) {
        toastEl.textContent = message;
        toastEl.className = 'toast show toast-error';
        setTimeout(function () { toastEl.classList.remove('show'); }, 4000);
      } else {
        alert(message);
      }
    }
  }

  // ─── Initialization ────────────────────────────────────────────────

  async function init() {
    var container = getContainer();
    if (!container) return;

    await loadMonitors();
    await loadDashboards();

    // Restore active dashboard or default
    if (dashboards.length > 0) {
      // Try to restore last used dashboard from localStorage
      var lastId = localStorage.getItem('rx-dashboard-active');
      if (lastId && dashboards.find(d => d.id === parseInt(lastId, 10))) {
        activeDashboardId = parseInt(lastId, 10);
      } else {
        activeDashboardId = dashboards[0].id;
      }
      await loadWidgets(activeDashboardId);
    } else {
      // Show default dashboard (Req 27.6)
      activeDashboardId = null;
      widgets = [];
    }

    renderDashboardSelector();
    renderGrid();
    injectStyles();
  }

  function injectStyles() {
    if (document.getElementById('custom-dashboard-styles')) return;

    var style = document.createElement('style');
    style.id = 'custom-dashboard-styles';
    style.textContent = getDashboardCSS();
    document.head.appendChild(style);
  }

  function getDashboardCSS() {
    return '' +
      '.dashboard-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px 0; }' +
      '.dashboard-select { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--color-border, #334155); ' +
        'background: var(--color-surface, #1e293b); color: var(--color-text, #e2e8f0); font-size: 0.9rem; }' +
      '.dashboard-btn-new, .dashboard-btn-rename, .dashboard-btn-delete, .dashboard-btn-add-widget { ' +
        'padding: 4px 10px; font-size: 0.8rem; border-radius: 4px; cursor: pointer; ' +
        'border: 1px solid var(--color-border, #334155); background: var(--color-surface, #1e293b); ' +
        'color: var(--color-text, #e2e8f0); }' +
      '.dashboard-btn-new:hover, .dashboard-btn-add-widget:hover { background: var(--color-primary, #6366f1); color: #fff; }' +
      '.dashboard-btn-delete:hover { background: #ef4444; color: #fff; }' +
      '.dashboard-btn-new:disabled, .dashboard-btn-add-widget:disabled { opacity: 0.5; cursor: not-allowed; }' +
      '.dashboard-grid { min-height: 200px; }' +
      '.dashboard-widget { background: var(--color-surface, #1e293b); border: 1px solid var(--color-border, #334155); ' +
        'border-radius: 8px; padding: 0; overflow: hidden; transition: box-shadow 0.2s, transform 0.2s; cursor: grab; }' +
      '.dashboard-widget:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.3); }' +
      '.dashboard-widget.dragging { opacity: 0.5; transform: scale(0.95); }' +
      '.widget-header { display: flex; justify-content: space-between; align-items: center; ' +
        'padding: 8px 12px; border-bottom: 1px solid var(--color-border, #334155); background: rgba(0,0,0,0.2); }' +
      '.widget-title { font-size: 0.8rem; font-weight: 600; color: var(--color-text-secondary, #94a3b8); text-transform: uppercase; letter-spacing: 0.5px; }' +
      '.widget-btn-remove { background: none; border: none; color: var(--color-text-secondary, #94a3b8); ' +
        'cursor: pointer; font-size: 1.2rem; line-height: 1; padding: 2px 6px; border-radius: 4px; }' +
      '.widget-btn-remove:hover { background: #ef4444; color: #fff; }' +
      '.widget-body { padding: 12px; min-height: 60px; display: flex; align-items: center; justify-content: center; }' +
      '.widget-empty-state { text-align: center; opacity: 0.6; font-size: 0.85rem; }' +
      '.widget-monitor-status { text-align: center; }' +
      '.widget-monitor-status .status-indicator { font-size: 1.5rem; font-weight: bold; margin-bottom: 4px; }' +
      '.widget-monitor-status .status-indicator.up { color: #10b981; }' +
      '.widget-monitor-status .status-indicator.down { color: #ef4444; }' +
      '.widget-monitor-status .monitor-name { font-size: 0.9rem; color: var(--color-text, #e2e8f0); }' +
      '.widget-monitor-status .monitor-url { font-size: 0.75rem; opacity: 0.6; }' +
      '.dashboard-empty-state { opacity: 0.6; }' +
      '.dashboard-modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; ' +
        'background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 10000; }' +
      '.dashboard-modal { background: var(--color-bg, #0f172a); border: 1px solid var(--color-border, #334155); ' +
        'border-radius: 12px; padding: 24px; width: 90%; max-width: 400px; }' +
      '.dashboard-modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }' +
      '.dashboard-modal-header h3 { margin: 0; color: var(--color-text, #e2e8f0); }' +
      '.dashboard-modal-close { background: none; border: none; font-size: 1.5rem; cursor: pointer; color: var(--color-text-secondary, #94a3b8); }' +
      '.add-widget-form .form-group { margin-bottom: 12px; }' +
      '.add-widget-form label { display: block; margin-bottom: 4px; font-size: 0.85rem; color: var(--color-text-secondary, #94a3b8); }' +
      '.add-widget-form select { width: 100%; padding: 8px; border-radius: 6px; border: 1px solid var(--color-border, #334155); ' +
        'background: var(--color-surface, #1e293b); color: var(--color-text, #e2e8f0); }' +
      '.add-widget-form .btn-primary { width: 100%; padding: 10px; border: none; border-radius: 6px; ' +
        'background: var(--color-primary, #6366f1); color: #fff; cursor: pointer; font-weight: 600; }' +
      '.add-widget-form .btn-primary:hover { opacity: 0.9; }';
  }

  // ─── Public API (exposed on window) ─────────────────────────────────

  window.CustomDashboard = {
    init: init,
    MAX_DASHBOARDS: MAX_DASHBOARDS,
    MAX_WIDGETS: MAX_WIDGETS,
    GRID_COLUMNS: GRID_COLUMNS,
    WIDGET_TYPES: WIDGET_TYPES,
    validateDashboardName: validateDashboardName,
    validateWidgetPosition: validateWidgetPosition,
    isValidWidgetType: isValidWidgetType
  };

  // Auto-initialize when DOM is ready and container exists
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      if (document.getElementById('custom-dashboard-container')) {
        init();
      }
    });
  } else {
    if (document.getElementById('custom-dashboard-container')) {
      init();
    }
  }

})();
