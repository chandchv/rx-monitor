import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load the heatmap script and evaluate in a simulated browser environment
function loadHeatmap() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost',
    runScripts: 'dangerously',
    resources: 'usable',
  });
  
  const script = readFileSync(resolve(__dirname, '../../public/js/heatmap.js'), 'utf-8');
  dom.window.eval(script);
  
  return dom.window.UptimeHeatmap;
}

describe('UptimeHeatmap', () => {
  let UptimeHeatmap;

  beforeEach(() => {
    UptimeHeatmap = loadHeatmap();
  });

  describe('classifyColor', () => {
    it('returns green for uptime >= 99.5%', () => {
      expect(UptimeHeatmap.classifyColor(99.5)).toEqual({ color: '#10b981', label: 'Excellent' });
      expect(UptimeHeatmap.classifyColor(100)).toEqual({ color: '#10b981', label: 'Excellent' });
      expect(UptimeHeatmap.classifyColor(99.9)).toEqual({ color: '#10b981', label: 'Excellent' });
    });

    it('returns light-green for uptime 95-99.4%', () => {
      expect(UptimeHeatmap.classifyColor(95)).toEqual({ color: '#22c55e', label: 'Good' });
      expect(UptimeHeatmap.classifyColor(99.4)).toEqual({ color: '#22c55e', label: 'Good' });
      expect(UptimeHeatmap.classifyColor(97.5)).toEqual({ color: '#22c55e', label: 'Good' });
    });

    it('returns amber for uptime 80-94.9%', () => {
      expect(UptimeHeatmap.classifyColor(80)).toEqual({ color: '#f59e0b', label: 'Degraded' });
      expect(UptimeHeatmap.classifyColor(94.9)).toEqual({ color: '#f59e0b', label: 'Degraded' });
      expect(UptimeHeatmap.classifyColor(87)).toEqual({ color: '#f59e0b', label: 'Degraded' });
    });

    it('returns red for uptime < 80%', () => {
      expect(UptimeHeatmap.classifyColor(79.9)).toEqual({ color: '#ef4444', label: 'Poor' });
      expect(UptimeHeatmap.classifyColor(0)).toEqual({ color: '#ef4444', label: 'Poor' });
      expect(UptimeHeatmap.classifyColor(50)).toEqual({ color: '#ef4444', label: 'Poor' });
    });

    it('returns gray for null/undefined/negative (no data)', () => {
      expect(UptimeHeatmap.classifyColor(null)).toEqual({ color: '#6b7280', label: 'No data' });
      expect(UptimeHeatmap.classifyColor(undefined)).toEqual({ color: '#6b7280', label: 'No data' });
      expect(UptimeHeatmap.classifyColor(-1)).toEqual({ color: '#6b7280', label: 'No data' });
    });

    // Boundary tests
    it('handles exact boundary at 99.5 (green)', () => {
      expect(UptimeHeatmap.classifyColor(99.5).color).toBe('#10b981');
    });

    it('handles value just below 99.5 (light-green)', () => {
      expect(UptimeHeatmap.classifyColor(99.49).color).toBe('#22c55e');
    });

    it('handles exact boundary at 95 (light-green)', () => {
      expect(UptimeHeatmap.classifyColor(95).color).toBe('#22c55e');
    });

    it('handles value just below 95 (amber)', () => {
      expect(UptimeHeatmap.classifyColor(94.99).color).toBe('#f59e0b');
    });

    it('handles exact boundary at 80 (amber)', () => {
      expect(UptimeHeatmap.classifyColor(80).color).toBe('#f59e0b');
    });

    it('handles value just below 80 (red)', () => {
      expect(UptimeHeatmap.classifyColor(79.99).color).toBe('#ef4444');
    });
  });

  describe('computePerDayUptime', () => {
    it('returns empty map for empty logs', () => {
      const result = UptimeHeatmap.computePerDayUptime([], 'UTC');
      expect(result.size).toBe(0);
    });

    it('computes 100% uptime for all UP checks on a day', () => {
      const logs = [
        { checked_at: '2024-01-15T10:00:00Z', status: 'UP' },
        { checked_at: '2024-01-15T11:00:00Z', status: 'UP' },
        { checked_at: '2024-01-15T12:00:00Z', status: 'UP' },
      ];
      const result = UptimeHeatmap.computePerDayUptime(logs, 'UTC');
      const day = result.get('2024-01-15');
      expect(day).toBeDefined();
      expect(day.uptime).toBe(100);
      expect(day.total).toBe(3);
      expect(day.failures).toBe(0);
    });

    it('computes correct uptime with mixed statuses', () => {
      const logs = [
        { checked_at: '2024-01-15T10:00:00Z', status: 'UP' },
        { checked_at: '2024-01-15T11:00:00Z', status: 'DOWN' },
        { checked_at: '2024-01-15T12:00:00Z', status: 'UP' },
        { checked_at: '2024-01-15T13:00:00Z', status: 'UP' },
      ];
      const result = UptimeHeatmap.computePerDayUptime(logs, 'UTC');
      const day = result.get('2024-01-15');
      expect(day.uptime).toBe(75); // 3/4 * 100
      expect(day.total).toBe(4);
      expect(day.failures).toBe(1);
    });

    it('computes 0% uptime for all DOWN checks', () => {
      const logs = [
        { checked_at: '2024-01-15T10:00:00Z', status: 'DOWN' },
        { checked_at: '2024-01-15T11:00:00Z', status: 'DOWN' },
      ];
      const result = UptimeHeatmap.computePerDayUptime(logs, 'UTC');
      const day = result.get('2024-01-15');
      expect(day.uptime).toBe(0);
      expect(day.failures).toBe(2);
    });

    it('groups checks by calendar day correctly', () => {
      const logs = [
        { checked_at: '2024-01-15T23:00:00Z', status: 'UP' },
        { checked_at: '2024-01-16T01:00:00Z', status: 'DOWN' },
      ];
      const result = UptimeHeatmap.computePerDayUptime(logs, 'UTC');
      expect(result.has('2024-01-15')).toBe(true);
      expect(result.has('2024-01-16')).toBe(true);
      expect(result.get('2024-01-15').uptime).toBe(100);
      expect(result.get('2024-01-16').uptime).toBe(0);
    });

    it('treats PENDING status as failure', () => {
      const logs = [
        { checked_at: '2024-01-15T10:00:00Z', status: 'UP' },
        { checked_at: '2024-01-15T11:00:00Z', status: 'PENDING' },
      ];
      const result = UptimeHeatmap.computePerDayUptime(logs, 'UTC');
      const day = result.get('2024-01-15');
      expect(day.uptime).toBe(50);
      expect(day.failures).toBe(1);
    });

    it('handles timezone correctly (date boundary shift)', () => {
      // 2024-01-15T23:00:00Z is 2024-01-16T08:00:00 in Asia/Tokyo (UTC+9)
      const logs = [
        { checked_at: '2024-01-15T23:00:00Z', status: 'UP' },
      ];
      const result = UptimeHeatmap.computePerDayUptime(logs, 'Asia/Tokyo');
      // In Tokyo timezone, this should be Jan 16
      expect(result.has('2024-01-16')).toBe(true);
      expect(result.get('2024-01-16').uptime).toBe(100);
    });

    it('defaults to UTC for invalid timezone', () => {
      const logs = [
        { checked_at: '2024-01-15T10:00:00Z', status: 'UP' },
      ];
      const result = UptimeHeatmap.computePerDayUptime(logs, 'Invalid/TZ');
      expect(result.has('2024-01-15')).toBe(true);
    });

    it('skips logs without checked_at', () => {
      const logs = [
        { status: 'UP' },
        { checked_at: '2024-01-15T10:00:00Z', status: 'UP' },
      ];
      const result = UptimeHeatmap.computePerDayUptime(logs, 'UTC');
      expect(result.size).toBe(1);
    });

    it('still calculates uptime for days with fewer checks than expected (Req 24.6)', () => {
      // Even a single check should produce an uptime value
      const logs = [
        { checked_at: '2024-01-15T10:00:00Z', status: 'UP' },
      ];
      const result = UptimeHeatmap.computePerDayUptime(logs, 'UTC');
      const day = result.get('2024-01-15');
      expect(day.uptime).toBe(100);
      expect(day.total).toBe(1);
    });
  });

  describe('generateDateRange', () => {
    it('returns correct number of dates', () => {
      const dates = UptimeHeatmap.generateDateRange(90, 'UTC');
      expect(dates).toHaveLength(90);
    });

    it('ends with today (most recent last per Req 24.1)', () => {
      const dates = UptimeHeatmap.generateDateRange(7, 'UTC');
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'UTC' });
      expect(dates[dates.length - 1]).toBe(today);
    });

    it('starts with the oldest date first', () => {
      const dates = UptimeHeatmap.generateDateRange(3, 'UTC');
      expect(dates.length).toBe(3);
      // Dates should be in chronological order
      expect(dates[0] < dates[1]).toBe(true);
      expect(dates[1] < dates[2]).toBe(true);
    });

    it('handles single day', () => {
      const dates = UptimeHeatmap.generateDateRange(1, 'UTC');
      expect(dates).toHaveLength(1);
    });
  });

  describe('render', () => {
    it('renders 90 cells into a container', () => {
      const dom = new JSDOM('<!DOCTYPE html><html><body><div id="hm"></div></body></html>', {
        url: 'http://localhost',
        runScripts: 'dangerously',
      });
      
      const script = readFileSync(resolve(__dirname, '../../public/js/heatmap.js'), 'utf-8');
      dom.window.eval(script);
      
      const container = dom.window.document.getElementById('hm');
      dom.window.UptimeHeatmap.render(container, { logs: [], timezone: 'UTC', days: 90 });
      
      const cells = container.querySelectorAll('.heatmap-cell');
      expect(cells.length).toBe(90);
    });

    it('applies correct color to cells based on log data', () => {
      const dom = new JSDOM('<!DOCTYPE html><html><body><div id="hm"></div></body></html>', {
        url: 'http://localhost',
        runScripts: 'dangerously',
      });
      
      const script = readFileSync(resolve(__dirname, '../../public/js/heatmap.js'), 'utf-8');
      dom.window.eval(script);
      
      const today = new Date().toISOString().split('T')[0];
      const logs = [
        { checked_at: today + 'T10:00:00Z', status: 'UP' },
        { checked_at: today + 'T11:00:00Z', status: 'UP' },
      ];
      
      const container = dom.window.document.getElementById('hm');
      dom.window.UptimeHeatmap.render(container, { logs, timezone: 'UTC', days: 90 });
      
      const cells = container.querySelectorAll('.heatmap-cell');
      const lastCell = cells[cells.length - 1];
      // 100% uptime should be green
      expect(lastCell.style.backgroundColor).toBe('rgb(16, 185, 129)');
    });

    it('cells are keyboard focusable (Req 24.3)', () => {
      const dom = new JSDOM('<!DOCTYPE html><html><body><div id="hm"></div></body></html>', {
        url: 'http://localhost',
        runScripts: 'dangerously',
      });
      
      const script = readFileSync(resolve(__dirname, '../../public/js/heatmap.js'), 'utf-8');
      dom.window.eval(script);
      
      const container = dom.window.document.getElementById('hm');
      dom.window.UptimeHeatmap.render(container, { logs: [], timezone: 'UTC', days: 90 });
      
      const cells = container.querySelectorAll('.heatmap-cell');
      for (const cell of cells) {
        expect(cell.getAttribute('tabindex')).toBe('0');
      }
    });

    it('cells have accessible aria-labels (Req 24.3)', () => {
      const dom = new JSDOM('<!DOCTYPE html><html><body><div id="hm"></div></body></html>', {
        url: 'http://localhost',
        runScripts: 'dangerously',
      });
      
      const script = readFileSync(resolve(__dirname, '../../public/js/heatmap.js'), 'utf-8');
      dom.window.eval(script);
      
      const container = dom.window.document.getElementById('hm');
      dom.window.UptimeHeatmap.render(container, { logs: [], timezone: 'UTC', days: 5 });
      
      const cells = container.querySelectorAll('.heatmap-cell');
      for (const cell of cells) {
        const label = cell.getAttribute('aria-label');
        expect(label).toContain('No data');
        expect(label).toContain('checks');
        expect(label).toContain('failures');
      }
    });

    it('creates a legend with all color categories', () => {
      const dom = new JSDOM('<!DOCTYPE html><html><body><div id="hm"></div></body></html>', {
        url: 'http://localhost',
        runScripts: 'dangerously',
      });
      
      const script = readFileSync(resolve(__dirname, '../../public/js/heatmap.js'), 'utf-8');
      dom.window.eval(script);
      
      const container = dom.window.document.getElementById('hm');
      dom.window.UptimeHeatmap.render(container, { logs: [], timezone: 'UTC', days: 90 });
      
      const legend = container.querySelector('.heatmap-legend');
      expect(legend).not.toBeNull();
      expect(legend.textContent).toContain('No data');
      expect(legend.textContent).toContain('<80%');
      expect(legend.textContent).toContain('80-94.9%');
      expect(legend.textContent).toContain('95-99.4%');
      expect(legend.textContent).toContain('≥99.5%');
    });

    it('no-data days get gray color', () => {
      const dom = new JSDOM('<!DOCTYPE html><html><body><div id="hm"></div></body></html>', {
        url: 'http://localhost',
        runScripts: 'dangerously',
      });
      
      const script = readFileSync(resolve(__dirname, '../../public/js/heatmap.js'), 'utf-8');
      dom.window.eval(script);
      
      const container = dom.window.document.getElementById('hm');
      dom.window.UptimeHeatmap.render(container, { logs: [], timezone: 'UTC', days: 5 });
      
      const cells = container.querySelectorAll('.heatmap-cell');
      // All cells should be gray since no logs provided
      for (const cell of cells) {
        expect(cell.style.backgroundColor).toBe('rgb(107, 114, 128)');
      }
    });
  });
});
