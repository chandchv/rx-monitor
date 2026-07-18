/**
 * Uptime Heatmap Renderer
 * 
 * Renders a 90-day calendar grid where each cell represents one day,
 * color-coded by uptime percentage. Supports tooltips on hover/focus
 * with date, uptime%, total checks, and failure count.
 * 
 * Requirements: 24.1, 24.2, 24.3, 24.4, 24.5, 24.6
 */

// Expose as a global namespace for use by other frontend code
window.UptimeHeatmap = (function () {
  'use strict';

  // --- Color Classification (Requirement 24.2) ---

  /**
   * Classify uptime percentage into a color category.
   * @param {number|null} uptimePercent - The uptime percentage (0-100), or null for no data
   * @returns {{ color: string, label: string }} Color hex and human-readable label
   */
  function classifyColor(uptimePercent) {
    if (uptimePercent === null || uptimePercent === undefined || uptimePercent < 0) {
      return { color: '#6b7280', label: 'No data' }; // gray
    }
    if (uptimePercent >= 99.5) {
      return { color: '#10b981', label: 'Excellent' }; // green
    }
    if (uptimePercent >= 95) {
      return { color: '#22c55e', label: 'Good' }; // light-green
    }
    if (uptimePercent >= 80) {
      return { color: '#f59e0b', label: 'Degraded' }; // amber
    }
    return { color: '#ef4444', label: 'Poor' }; // red
  }

  // --- Per-Day Uptime Calculation (Requirement 24.5) ---

  /**
   * Calculate per-day uptime from an array of check log entries.
   * Groups checks by calendar day in the specified timezone.
   * 
   * @param {Array} logs - Array of check log objects with { checked_at, status }
   * @param {string} timezone - IANA timezone string (default 'UTC')
   * @returns {Map<string, { uptime: number, total: number, failures: number }>}
   *   Map keyed by ISO date string (YYYY-MM-DD)
   */
  function computePerDayUptime(logs, timezone) {
    timezone = timezone || 'UTC';
    const dayMap = new Map();

    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];
      if (!log.checked_at) continue;

      // Get the date string in the monitor's timezone
      var dayStr;
      try {
        dayStr = new Date(log.checked_at).toLocaleDateString('en-CA', { timeZone: timezone });
      } catch (e) {
        // Fallback to UTC if timezone is invalid
        dayStr = new Date(log.checked_at).toISOString().split('T')[0];
      }

      if (!dayMap.has(dayStr)) {
        dayMap.set(dayStr, { total: 0, failures: 0 });
      }

      var entry = dayMap.get(dayStr);
      entry.total++;

      // Consider anything not 'UP' as a failure
      if (log.status !== 'UP') {
        entry.failures++;
      }
    }

    // Calculate uptime percentage for each day
    var result = new Map();
    dayMap.forEach(function (value, key) {
      var uptime = value.total > 0
        ? ((value.total - value.failures) / value.total) * 100
        : null;
      result.set(key, {
        uptime: uptime !== null ? Math.round(uptime * 100) / 100 : null,
        total: value.total,
        failures: value.failures
      });
    });

    return result;
  }

  // --- Date Utilities ---

  /**
   * Generate an array of date strings for the last N days (most recent last).
   * @param {number} days - Number of days to generate
   * @param {string} timezone - IANA timezone string
   * @returns {string[]} Array of YYYY-MM-DD date strings
   */
  function generateDateRange(days, timezone) {
    timezone = timezone || 'UTC';
    var dates = [];
    var now = new Date();

    for (var i = days - 1; i >= 0; i--) {
      var d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      var dayStr;
      try {
        dayStr = d.toLocaleDateString('en-CA', { timeZone: timezone });
      } catch (e) {
        dayStr = d.toISOString().split('T')[0];
      }
      dates.push(dayStr);
    }

    return dates;
  }

  /**
   * Format a date string for display.
   * @param {string} dateStr - YYYY-MM-DD date string
   * @returns {string} Human-readable date
   */
  function formatDate(dateStr) {
    var parts = dateStr.split('-');
    var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    return d.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }

  // --- Tooltip (Requirement 24.3) ---

  var activeTooltip = null;

  /**
   * Create and show a tooltip near the target element.
   * @param {HTMLElement} target - The heatmap cell element
   * @param {object} data - { date, uptime, total, failures }
   */
  function showTooltip(target, data) {
    hideTooltip();

    var tooltip = document.createElement('div');
    tooltip.className = 'heatmap-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.id = 'heatmap-tooltip-' + Date.now();

    var uptimeText = data.uptime !== null
      ? data.uptime.toFixed(2) + '%'
      : 'No data';

    tooltip.innerHTML =
      '<div class="heatmap-tooltip-date">' + escapeHtml(formatDate(data.date)) + '</div>' +
      '<div class="heatmap-tooltip-row"><span>Uptime:</span> <strong>' + uptimeText + '</strong></div>' +
      '<div class="heatmap-tooltip-row"><span>Total checks:</span> <strong>' + data.total + '</strong></div>' +
      '<div class="heatmap-tooltip-row"><span>Failures:</span> <strong>' + data.failures + '</strong></div>';

    document.body.appendChild(tooltip);

    // Position tooltip above the cell
    var rect = target.getBoundingClientRect();
    var tooltipRect = tooltip.getBoundingClientRect();
    var top = rect.top - tooltipRect.height - 8 + window.scrollY;
    var left = rect.left + (rect.width / 2) - (tooltipRect.width / 2) + window.scrollX;

    // Keep tooltip within viewport
    if (top < window.scrollY) {
      top = rect.bottom + 8 + window.scrollY;
    }
    if (left < 4) left = 4;
    if (left + tooltipRect.width > window.innerWidth - 4) {
      left = window.innerWidth - tooltipRect.width - 4;
    }

    tooltip.style.top = top + 'px';
    tooltip.style.left = left + 'px';
    tooltip.style.opacity = '1';

    // Set aria-describedby on target
    target.setAttribute('aria-describedby', tooltip.id);

    activeTooltip = tooltip;
  }

  /**
   * Hide and remove the active tooltip.
   */
  function hideTooltip() {
    if (activeTooltip) {
      var described = document.querySelector('[aria-describedby="' + activeTooltip.id + '"]');
      if (described) {
        described.removeAttribute('aria-describedby');
      }
      activeTooltip.remove();
      activeTooltip = null;
    }
  }

  // --- Rendering (Requirements 24.1, 24.4, 24.6) ---

  /**
   * Render a 90-day uptime heatmap calendar grid into the specified container.
   * 
   * @param {HTMLElement|string} container - DOM element or selector for the container
   * @param {object} options
   * @param {Array} options.logs - Array of check log entries with { checked_at, status }
   * @param {string} [options.timezone='UTC'] - IANA timezone for per-day grouping
   * @param {number} [options.days=90] - Number of days to display
   * @param {number} [options.cellSize=16] - Size of each cell in pixels
   * @param {number} [options.cellGap=3] - Gap between cells in pixels
   */
  function render(container, options) {
    if (typeof container === 'string') {
      container = document.querySelector(container);
    }
    if (!container) {
      console.error('[UptimeHeatmap] Container not found');
      return;
    }

    options = options || {};
    var logs = options.logs || [];
    var timezone = options.timezone || 'UTC';
    var days = options.days || 90;
    var cellSize = options.cellSize || 16;
    var cellGap = options.cellGap || 3;

    // Compute per-day uptime data
    var dayData = computePerDayUptime(logs, timezone);
    var dateRange = generateDateRange(days, timezone);

    // Clear existing content
    container.innerHTML = '';

    // Create wrapper
    var wrapper = document.createElement('div');
    wrapper.className = 'heatmap-wrapper';
    wrapper.setAttribute('role', 'img');
    wrapper.setAttribute('aria-label', days + '-day uptime heatmap. Most recent day on the right.');

    // Create the grid container
    var grid = document.createElement('div');
    grid.className = 'heatmap-grid';
    grid.style.display = 'flex';
    grid.style.flexWrap = 'wrap';
    grid.style.gap = cellGap + 'px';
    grid.style.alignItems = 'flex-start';

    // Create cells for each day
    for (var i = 0; i < dateRange.length; i++) {
      var dateStr = dateRange[i];
      var data = dayData.get(dateStr) || { uptime: null, total: 0, failures: 0 };
      var classification = classifyColor(data.uptime);

      var cell = document.createElement('div');
      cell.className = 'heatmap-cell';
      cell.setAttribute('tabindex', '0');
      cell.setAttribute('role', 'button');
      cell.setAttribute('aria-label',
        formatDate(dateStr) + ': ' +
        (data.uptime !== null ? data.uptime.toFixed(2) + '% uptime' : 'No data') +
        ', ' + data.total + ' checks, ' + data.failures + ' failures'
      );
      cell.style.width = cellSize + 'px';
      cell.style.height = cellSize + 'px';
      cell.style.backgroundColor = classification.color;
      cell.style.borderRadius = '3px';
      cell.style.cursor = 'pointer';
      cell.style.transition = 'transform 0.1s ease, box-shadow 0.1s ease';

      // Store data on the element for tooltip use
      cell.dataset.date = dateStr;
      cell.dataset.uptime = data.uptime !== null ? data.uptime : '';
      cell.dataset.total = data.total;
      cell.dataset.failures = data.failures;

      // Event listeners for tooltip (hover and keyboard focus)
      cell.addEventListener('mouseenter', handleCellEnter);
      cell.addEventListener('mouseleave', handleCellLeave);
      cell.addEventListener('focus', handleCellEnter);
      cell.addEventListener('blur', handleCellLeave);

      grid.appendChild(cell);
    }

    wrapper.appendChild(grid);

    // Create legend
    var legend = createLegend();
    wrapper.appendChild(legend);

    // Create date labels row
    var labels = document.createElement('div');
    labels.className = 'heatmap-labels';
    labels.style.display = 'flex';
    labels.style.justifyContent = 'space-between';
    labels.style.marginTop = '8px';
    labels.style.fontSize = '10px';
    labels.style.color = 'var(--color-muted, #94a3b8)';

    var labelStart = document.createElement('span');
    labelStart.textContent = days + ' days ago';
    var labelEnd = document.createElement('span');
    labelEnd.textContent = 'Today';

    labels.appendChild(labelStart);
    labels.appendChild(labelEnd);
    wrapper.appendChild(labels);

    container.appendChild(wrapper);
  }

  /**
   * Create the color legend element.
   * @returns {HTMLElement}
   */
  function createLegend() {
    var legend = document.createElement('div');
    legend.className = 'heatmap-legend';
    legend.style.display = 'flex';
    legend.style.alignItems = 'center';
    legend.style.gap = '6px';
    legend.style.marginTop = '10px';
    legend.style.fontSize = '10px';
    legend.style.color = 'var(--color-muted, #94a3b8)';

    var items = [
      { color: '#6b7280', label: 'No data' },
      { color: '#ef4444', label: '<80%' },
      { color: '#f59e0b', label: '80-94.9%' },
      { color: '#22c55e', label: '95-99.4%' },
      { color: '#10b981', label: '≥99.5%' }
    ];

    for (var i = 0; i < items.length; i++) {
      var swatch = document.createElement('div');
      swatch.style.width = '12px';
      swatch.style.height = '12px';
      swatch.style.backgroundColor = items[i].color;
      swatch.style.borderRadius = '2px';
      swatch.title = items[i].label;
      legend.appendChild(swatch);

      var label = document.createElement('span');
      label.textContent = items[i].label;
      label.style.marginRight = '6px';
      legend.appendChild(label);
    }

    return legend;
  }

  // --- Event Handlers ---

  function handleCellEnter(e) {
    var cell = e.currentTarget;
    cell.style.transform = 'scale(1.3)';
    cell.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
    cell.style.zIndex = '10';
    cell.style.position = 'relative';

    var uptimeVal = cell.dataset.uptime !== '' ? parseFloat(cell.dataset.uptime) : null;
    showTooltip(cell, {
      date: cell.dataset.date,
      uptime: uptimeVal,
      total: parseInt(cell.dataset.total) || 0,
      failures: parseInt(cell.dataset.failures) || 0
    });
  }

  function handleCellLeave(e) {
    var cell = e.currentTarget;
    cell.style.transform = '';
    cell.style.boxShadow = '';
    cell.style.zIndex = '';
    cell.style.position = '';
    hideTooltip();
  }

  // --- Utility ---

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Inject Tooltip Styles ---

  function injectStyles() {
    if (document.getElementById('heatmap-tooltip-styles')) return;

    var style = document.createElement('style');
    style.id = 'heatmap-tooltip-styles';
    style.textContent = [
      '.heatmap-tooltip {',
      '  position: absolute;',
      '  z-index: 9999;',
      '  background: var(--color-card-bg, #1e293b);',
      '  border: 1px solid var(--color-border, rgba(255,255,255,0.1));',
      '  border-radius: 8px;',
      '  padding: 10px 14px;',
      '  font-family: "Outfit", sans-serif;',
      '  font-size: 12px;',
      '  color: var(--color-text, #e2e8f0);',
      '  box-shadow: 0 4px 16px rgba(0,0,0,0.4);',
      '  pointer-events: none;',
      '  opacity: 0;',
      '  transition: opacity 0.15s ease;',
      '  min-width: 160px;',
      '}',
      '.heatmap-tooltip-date {',
      '  font-weight: 600;',
      '  margin-bottom: 6px;',
      '  font-size: 11px;',
      '  color: var(--color-muted, #94a3b8);',
      '}',
      '.heatmap-tooltip-row {',
      '  display: flex;',
      '  justify-content: space-between;',
      '  margin-bottom: 3px;',
      '}',
      '.heatmap-tooltip-row strong {',
      '  color: var(--color-primary, #6366f1);',
      '}',
      '.heatmap-cell:focus {',
      '  outline: 2px solid var(--color-primary, #6366f1);',
      '  outline-offset: 2px;',
      '}'
    ].join('\n');

    document.head.appendChild(style);
  }

  // --- Auto-Initialize ---

  /**
   * Auto-initialize heatmap if a container with [data-heatmap-monitor] is present.
   * Fetches data from the API and renders the heatmap.
   * 
   * Usage: <div data-heatmap-monitor="123" data-heatmap-timezone="America/New_York"></div>
   */
  function autoInit() {
    injectStyles();

    var containers = document.querySelectorAll('[data-heatmap-monitor]');
    for (var i = 0; i < containers.length; i++) {
      var el = containers[i];
      var monId = el.getAttribute('data-heatmap-monitor');
      var tz = el.getAttribute('data-heatmap-timezone') || 'UTC';

      if (monId) {
        fetchAndRender(el, monId, tz);
      }
    }
  }

  /**
   * Fetch heatmap data from the API and render into container.
   * @param {HTMLElement} container
   * @param {string|number} monitorId
   * @param {string} timezone
   */
  function fetchAndRender(container, monitorId, timezone) {
    fetch('/api/monitors/' + monitorId + '/heatmap?days=90')
      .then(function (res) {
        if (!res.ok) {
          // Fallback: try to fetch logs and compute locally
          return fetch('/api/monitors/' + monitorId + '?logs=90d')
            .then(function (r) { return r.json(); })
            .then(function (data) {
              var tz = data.timezone || timezone || 'UTC';
              render(container, {
                logs: data.logs || [],
                timezone: tz,
                days: 90
              });
            });
        }
        return res.json().then(function (heatmapData) {
          // If API returns pre-computed data, render from that
          renderFromApiData(container, heatmapData, timezone);
        });
      })
      .catch(function (err) {
        console.error('[UptimeHeatmap] Failed to load data:', err);
        container.innerHTML = '<div style="font-size: 12px; color: var(--color-muted, #94a3b8); text-align: center; padding: 20px;">Unable to load heatmap data</div>';
      });
  }

  /**
   * Render heatmap from pre-computed API response data.
   * Expected shape: { days: [{ date, uptime, total, failures }], timezone }
   */
  function renderFromApiData(container, apiData, fallbackTimezone) {
    var timezone = apiData.timezone || fallbackTimezone || 'UTC';
    var days = apiData.days || [];
    var numDays = 90;

    container.innerHTML = '';
    injectStyles();

    var dateRange = generateDateRange(numDays, timezone);

    // Build lookup from API data
    var lookup = {};
    for (var i = 0; i < days.length; i++) {
      lookup[days[i].date] = days[i];
    }

    // Create wrapper
    var wrapper = document.createElement('div');
    wrapper.className = 'heatmap-wrapper';
    wrapper.setAttribute('role', 'img');
    wrapper.setAttribute('aria-label', numDays + '-day uptime heatmap. Most recent day on the right.');

    // Create grid
    var grid = document.createElement('div');
    grid.className = 'heatmap-grid';
    grid.style.display = 'flex';
    grid.style.flexWrap = 'wrap';
    grid.style.gap = '3px';

    for (var j = 0; j < dateRange.length; j++) {
      var dateStr = dateRange[j];
      var data = lookup[dateStr] || { uptime: null, total: 0, failures: 0 };
      var uptimeVal = data.uptime !== null && data.uptime !== undefined ? data.uptime : null;
      var classification = classifyColor(uptimeVal);

      var cell = document.createElement('div');
      cell.className = 'heatmap-cell';
      cell.setAttribute('tabindex', '0');
      cell.setAttribute('role', 'button');
      cell.setAttribute('aria-label',
        formatDate(dateStr) + ': ' +
        (uptimeVal !== null ? uptimeVal.toFixed(2) + '% uptime' : 'No data') +
        ', ' + (data.total || 0) + ' checks, ' + (data.failures || 0) + ' failures'
      );
      cell.style.width = '16px';
      cell.style.height = '16px';
      cell.style.backgroundColor = classification.color;
      cell.style.borderRadius = '3px';
      cell.style.cursor = 'pointer';
      cell.style.transition = 'transform 0.1s ease, box-shadow 0.1s ease';

      cell.dataset.date = dateStr;
      cell.dataset.uptime = uptimeVal !== null ? uptimeVal : '';
      cell.dataset.total = data.total || 0;
      cell.dataset.failures = data.failures || 0;

      cell.addEventListener('mouseenter', handleCellEnter);
      cell.addEventListener('mouseleave', handleCellLeave);
      cell.addEventListener('focus', handleCellEnter);
      cell.addEventListener('blur', handleCellLeave);

      grid.appendChild(cell);
    }

    wrapper.appendChild(grid);
    wrapper.appendChild(createLegend());

    var labels = document.createElement('div');
    labels.style.display = 'flex';
    labels.style.justifyContent = 'space-between';
    labels.style.marginTop = '8px';
    labels.style.fontSize = '10px';
    labels.style.color = 'var(--color-muted, #94a3b8)';

    var labelStart = document.createElement('span');
    labelStart.textContent = numDays + ' days ago';
    var labelEnd = document.createElement('span');
    labelEnd.textContent = 'Today';
    labels.appendChild(labelStart);
    labels.appendChild(labelEnd);
    wrapper.appendChild(labels);

    container.appendChild(wrapper);
  }

  // --- Public API ---

  // Auto-initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }

  return {
    render: render,
    classifyColor: classifyColor,
    computePerDayUptime: computePerDayUptime,
    generateDateRange: generateDateRange,
    fetchAndRender: fetchAndRender,
    injectStyles: injectStyles
  };
})();
