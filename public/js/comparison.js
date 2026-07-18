/**
 * comparison.js — Multi-Monitor Comparison Chart
 *
 * Renders overlaid time-series chart for 2-10 monitors on a shared canvas.
 * Time windows: 1h, 6h, 24h, 7d (default 24h).
 * Shared Y-axis auto-scaled to min/max across all monitors.
 * Legend with monitor name + color + "no data" label when applicable.
 *
 * Requirements: 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7
 */

// eslint-disable-next-line no-unused-vars
const ComparisonChart = (function () {
  'use strict';

  // ─── Constants ──────────────────────────────────────────────────────
  const MIN_MONITORS = 2;
  const MAX_MONITORS = 10;

  const TIME_WINDOWS = {
    '1h': { label: '1 Hour', ms: 60 * 60 * 1000 },
    '6h': { label: '6 Hours', ms: 6 * 60 * 60 * 1000 },
    '24h': { label: '24 Hours', ms: 24 * 60 * 60 * 1000 },
    '7d': { label: '7 Days', ms: 7 * 24 * 60 * 60 * 1000 }
  };

  const DEFAULT_WINDOW = '24h';

  // 10 distinct colors for up to 10 monitors
  const LINE_COLORS = [
    '#6366f1', // indigo
    '#ef4444', // red
    '#10b981', // emerald
    '#f59e0b', // amber
    '#8b5cf6', // violet
    '#ec4899', // pink
    '#14b8a6', // teal
    '#f97316', // orange
    '#06b6d4', // cyan
    '#84cc16'  // lime
  ];

  // ─── Chart Rendering ───────────────────────────────────────────────

  const PADDING = { top: 20, right: 20, bottom: 40, left: 60 };

  /**
   * Compute the Y-axis range from all data series.
   * Returns { min, max } with a small padding factor.
   */
  function computeYRange(seriesArray) {
    let globalMin = Infinity;
    let globalMax = -Infinity;

    for (const series of seriesArray) {
      if (!series.data || series.data.length === 0) continue;
      for (const point of series.data) {
        if (point.value < globalMin) globalMin = point.value;
        if (point.value > globalMax) globalMax = point.value;
      }
    }

    if (globalMin === Infinity) return { min: 0, max: 100 };

    // Add 10% padding above and below
    const range = globalMax - globalMin || 1;
    return {
      min: Math.max(0, globalMin - range * 0.1),
      max: globalMax + range * 0.1
    };
  }

  /**
   * Compute the X-axis range from current time window.
   */
  function computeXRange(timeWindow) {
    const now = Date.now();
    const windowMs = TIME_WINDOWS[timeWindow].ms;
    return { min: now - windowMs, max: now };
  }

  /**
   * Render nice Y-axis tick labels.
   */
  function computeYTicks(yMin, yMax, count) {
    const ticks = [];
    const step = (yMax - yMin) / (count - 1);
    for (let i = 0; i < count; i++) {
      ticks.push(yMin + step * i);
    }
    return ticks;
  }

  /**
   * Format time label for X-axis.
   */
  function formatTimeLabel(timestamp, timeWindow) {
    const date = new Date(timestamp);
    if (timeWindow === '7d') {
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  /**
   * Draw the comparison chart on a canvas element.
   */
  function drawChart(canvas, seriesArray, timeWindow) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();

    // Set canvas internal resolution to match display
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const plotWidth = width - PADDING.left - PADDING.right;
    const plotHeight = height - PADDING.top - PADDING.bottom;

    // Clear
    ctx.clearRect(0, 0, width, height);

    // Compute axis ranges
    const yRange = computeYRange(seriesArray);
    const xRange = computeXRange(timeWindow);

    // Coordinate mappers
    function mapX(timestamp) {
      return PADDING.left + ((timestamp - xRange.min) / (xRange.max - xRange.min)) * plotWidth;
    }
    function mapY(value) {
      return PADDING.top + plotHeight - ((value - yRange.min) / (yRange.max - yRange.min)) * plotHeight;
    }

    // ─── Draw grid ─────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.15)';
    ctx.lineWidth = 1;

    // Y grid lines and labels
    const yTicks = computeYTicks(yRange.min, yRange.max, 5);
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (const tick of yTicks) {
      const y = mapY(tick);
      ctx.beginPath();
      ctx.moveTo(PADDING.left, y);
      ctx.lineTo(width - PADDING.right, y);
      ctx.stroke();
      ctx.fillText(Math.round(tick) + ' ms', PADDING.left - 8, y);
    }

    // X grid lines and labels
    const xTickCount = timeWindow === '7d' ? 7 : 6;
    const xStep = (xRange.max - xRange.min) / xTickCount;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (let i = 0; i <= xTickCount; i++) {
      const timestamp = xRange.min + xStep * i;
      const x = mapX(timestamp);
      ctx.beginPath();
      ctx.moveTo(x, PADDING.top);
      ctx.lineTo(x, PADDING.top + plotHeight);
      ctx.stroke();
      ctx.fillText(formatTimeLabel(timestamp, timeWindow), x, PADDING.top + plotHeight + 6);
    }

    // ─── Draw data lines ───────────────────────────────────────
    for (const series of seriesArray) {
      if (!series.data || series.data.length === 0) continue;

      // Sort data by timestamp
      const sorted = series.data.slice().sort((a, b) => a.timestamp - b.timestamp);

      ctx.beginPath();
      ctx.strokeStyle = series.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      let started = false;
      for (const point of sorted) {
        const x = mapX(point.timestamp);
        const y = mapY(point.value);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();

      // Draw data points if few enough
      if (sorted.length <= 50) {
        ctx.fillStyle = series.color;
        for (const point of sorted) {
          const x = mapX(point.timestamp);
          const y = mapY(point.value);
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // ─── Draw axes border ──────────────────────────────────────
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PADDING.left, PADDING.top);
    ctx.lineTo(PADDING.left, PADDING.top + plotHeight);
    ctx.lineTo(width - PADDING.right, PADDING.top + plotHeight);
    ctx.stroke();
  }

  // ─── Legend Rendering ──────────────────────────────────────────────

  /**
   * Render the legend container with monitor names, colors, and "no data" labels.
   */
  function renderLegend(legendContainer, seriesArray) {
    legendContainer.innerHTML = '';

    for (const series of seriesArray) {
      const item = document.createElement('div');
      item.className = 'comparison-legend-item';
      item.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-right:16px;margin-bottom:6px;font-size:13px;';

      const swatch = document.createElement('span');
      swatch.style.cssText = 'display:inline-block;width:12px;height:12px;border-radius:2px;background:' + series.color + ';';
      item.appendChild(swatch);

      const label = document.createElement('span');
      label.style.color = '#e2e8f0';
      label.textContent = series.name;
      item.appendChild(label);

      if (!series.data || series.data.length === 0) {
        const noData = document.createElement('span');
        noData.style.cssText = 'color:#94a3b8;font-style:italic;margin-left:4px;';
        noData.textContent = '(no data)';
        item.appendChild(noData);
      }

      legendContainer.appendChild(item);
    }
  }

  // ─── Error Display ─────────────────────────────────────────────────

  function showError(container, message) {
    container.innerHTML = '';
    const errDiv = document.createElement('div');
    errDiv.className = 'comparison-error';
    errDiv.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;color:#f87171;font-size:14px;text-align:center;padding:24px;';
    errDiv.setAttribute('role', 'alert');
    errDiv.textContent = message;
    container.appendChild(errDiv);
  }

  // ─── Data Fetching ─────────────────────────────────────────────────

  /**
   * Fetch comparison data for the given monitor IDs and time window.
   * Expected API: GET /api/monitors/comparison?ids=1,2,3&window=24h
   * Response: { monitors: [{ id, name, data: [{ timestamp, response_time }] }] }
   */
  async function fetchComparisonData(monitorIds, timeWindow) {
    const params = new URLSearchParams({
      ids: monitorIds.join(','),
      window: timeWindow
    });

    const token = localStorage.getItem('rx-monitor-token');
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }

    const response = await fetch('/api/monitors/comparison?' + params.toString(), { headers });
    if (!response.ok) {
      throw new Error('Failed to fetch comparison data (HTTP ' + response.status + ')');
    }
    return response.json();
  }

  // ─── Public API ────────────────────────────────────────────────────

  /**
   * Initialize a comparison chart.
   *
   * @param {Object} options
   * @param {HTMLElement} options.container - Wrapper element for the chart
   * @param {number[]} options.monitorIds - Array of monitor IDs to compare
   * @param {string} [options.timeWindow='24h'] - Time window (1h, 6h, 24h, 7d)
   * @param {Function} [options.onError] - Custom error callback
   * @returns {Object} Chart controller with update/destroy methods
   */
  function init(options) {
    const { container, monitorIds, timeWindow: initialWindow, onError } = options;
    let currentWindow = initialWindow || DEFAULT_WINDOW;
    let currentMonitorIds = monitorIds || [];
    let destroyed = false;

    // Validate monitor count
    if (!currentMonitorIds || currentMonitorIds.length < MIN_MONITORS) {
      showError(container, 'At least ' + MIN_MONITORS + ' monitors must be selected for comparison.');
      return createController();
    }

    if (currentMonitorIds.length > MAX_MONITORS) {
      currentMonitorIds = currentMonitorIds.slice(0, MAX_MONITORS);
    }

    // Build DOM structure
    container.innerHTML = '';
    container.style.position = 'relative';

    // Time window selector
    const controlsBar = document.createElement('div');
    controlsBar.className = 'comparison-controls';
    controlsBar.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap;';

    const windowLabel = document.createElement('span');
    windowLabel.style.cssText = 'color:#94a3b8;font-size:12px;margin-right:4px;';
    windowLabel.textContent = 'Time Window:';
    controlsBar.appendChild(windowLabel);

    Object.keys(TIME_WINDOWS).forEach(function (key) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'comparison-window-btn';
      btn.dataset.window = key;
      btn.textContent = TIME_WINDOWS[key].label;
      btn.style.cssText = 'padding:4px 10px;border-radius:4px;border:1px solid rgba(148,163,184,0.3);background:transparent;color:#e2e8f0;font-size:12px;cursor:pointer;transition:all 0.15s;';
      if (key === currentWindow) {
        btn.style.background = '#6366f1';
        btn.style.borderColor = '#6366f1';
        btn.style.color = '#fff';
      }
      btn.addEventListener('click', function () {
        if (destroyed) return;
        currentWindow = key;
        controlsBar.querySelectorAll('.comparison-window-btn').forEach(function (b) {
          b.style.background = 'transparent';
          b.style.borderColor = 'rgba(148,163,184,0.3)';
          b.style.color = '#e2e8f0';
        });
        btn.style.background = '#6366f1';
        btn.style.borderColor = '#6366f1';
        btn.style.color = '#fff';
        loadData();
      });
      controlsBar.appendChild(btn);
    });

    container.appendChild(controlsBar);

    // Legend container
    const legendContainer = document.createElement('div');
    legendContainer.className = 'comparison-legend';
    legendContainer.style.cssText = 'display:flex;flex-wrap:wrap;margin-bottom:8px;';
    legendContainer.setAttribute('aria-label', 'Chart legend');
    container.appendChild(legendContainer);

    // Canvas
    const canvasWrapper = document.createElement('div');
    canvasWrapper.style.cssText = 'position:relative;width:100%;height:300px;';
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;height:100%;display:block;';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Multi-monitor response time comparison chart');
    canvasWrapper.appendChild(canvas);
    container.appendChild(canvasWrapper);

    // Loading indicator
    const loadingEl = document.createElement('div');
    loadingEl.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#94a3b8;font-size:13px;display:none;';
    loadingEl.textContent = 'Loading…';
    canvasWrapper.appendChild(loadingEl);

    // ─── Data Loading ────────────────────────────────────────────
    async function loadData() {
      if (destroyed) return;

      loadingEl.style.display = 'block';
      canvas.style.opacity = '0.3';

      try {
        const result = await fetchComparisonData(currentMonitorIds, currentWindow);
        if (destroyed) return;

        const seriesArray = (result.monitors || []).map(function (monitor, index) {
          return {
            id: monitor.id,
            name: monitor.name,
            color: LINE_COLORS[index % LINE_COLORS.length],
            data: (monitor.data || []).map(function (point) {
              return {
                timestamp: new Date(point.timestamp || point.checked_at).getTime(),
                value: point.response_time || point.avg_response_time || 0
              };
            })
          };
        });

        renderLegend(legendContainer, seriesArray);
        drawChart(canvas, seriesArray, currentWindow);
      } catch (err) {
        if (onError) {
          onError(err);
        } else {
          showError(canvasWrapper, err.message || 'Failed to load comparison data.');
        }
      } finally {
        loadingEl.style.display = 'none';
        canvas.style.opacity = '1';
      }
    }

    // Initial load
    loadData();

    // Resize handler
    let resizeTimeout;
    function handleResize() {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(function () {
        if (!destroyed) loadData();
      }, 200);
    }
    window.addEventListener('resize', handleResize);

    // ─── Controller ──────────────────────────────────────────────
    function createController() {
      return {
        update: function (newMonitorIds, newWindow) {
          if (destroyed) return;
          if (newMonitorIds) {
            if (newMonitorIds.length < MIN_MONITORS) {
              showError(container, 'At least ' + MIN_MONITORS + ' monitors must be selected for comparison.');
              return;
            }
            currentMonitorIds = newMonitorIds.slice(0, MAX_MONITORS);
          }
          if (newWindow && TIME_WINDOWS[newWindow]) {
            currentWindow = newWindow;
            controlsBar.querySelectorAll('.comparison-window-btn').forEach(function (b) {
              b.style.background = 'transparent';
              b.style.borderColor = 'rgba(148,163,184,0.3)';
              b.style.color = '#e2e8f0';
              if (b.dataset.window === currentWindow) {
                b.style.background = '#6366f1';
                b.style.borderColor = '#6366f1';
                b.style.color = '#fff';
              }
            });
          }
          loadData();
        },
        setTimeWindow: function (win) {
          if (destroyed) return;
          if (TIME_WINDOWS[win]) {
            currentWindow = win;
            loadData();
          }
        },
        refresh: function () {
          if (!destroyed) loadData();
        },
        destroy: function () {
          destroyed = true;
          window.removeEventListener('resize', handleResize);
          container.innerHTML = '';
        },
        getTimeWindow: function () {
          return currentWindow;
        },
        getMonitorIds: function () {
          return currentMonitorIds.slice();
        }
      };
    }

    return createController();
  }

  // ─── Exports ───────────────────────────────────────────────────────
  const exports = {
    init: init,
    MIN_MONITORS: MIN_MONITORS,
    MAX_MONITORS: MAX_MONITORS,
    TIME_WINDOWS: TIME_WINDOWS,
    DEFAULT_WINDOW: DEFAULT_WINDOW,
    LINE_COLORS: LINE_COLORS,
    // Expose internals for testing
    _computeYRange: computeYRange,
    _computeXRange: computeXRange,
    _drawChart: drawChart,
    _renderLegend: renderLegend,
    _showError: showError
  };

  // Support Node.js/test environments
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }

  return exports;
})();
