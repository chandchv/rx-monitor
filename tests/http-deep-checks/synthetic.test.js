import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateTransactionConfig, executeSyntheticTransaction, getTransactionResults } from '../../synthetic.js';

describe('synthetic', () => {
  describe('validateTransactionConfig', () => {
    it('returns valid for a proper config with 2 steps', () => {
      const config = {
        steps: [
          { url: 'https://example.com/login', method: 'POST' },
          { url: 'https://example.com/dashboard', method: 'GET' }
        ]
      };
      const result = validateTransactionConfig(config);
      expect(result).toEqual({ valid: true, errors: [] });
    });

    it('returns valid for 20 steps (max allowed)', () => {
      const steps = Array.from({ length: 20 }, (_, i) => ({
        url: `https://example.com/step${i}`,
        method: 'GET'
      }));
      const result = validateTransactionConfig({ steps });
      expect(result).toEqual({ valid: true, errors: [] });
    });

    it('rejects fewer than 2 steps', () => {
      const config = { steps: [{ url: 'https://example.com', method: 'GET' }] };
      const result = validateTransactionConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Minimum of 2 steps required');
    });

    it('rejects empty steps array', () => {
      const config = { steps: [] };
      const result = validateTransactionConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Minimum of 2 steps required');
    });

    it('rejects more than 20 steps', () => {
      const steps = Array.from({ length: 21 }, (_, i) => ({
        url: `https://example.com/step${i}`,
        method: 'GET'
      }));
      const result = validateTransactionConfig({ steps });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Maximum step limit'))).toBe(true);
    });

    it('rejects null config', () => {
      const result = validateTransactionConfig(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Configuration must be an object');
    });

    it('rejects config without steps array', () => {
      const result = validateTransactionConfig({ steps: 'not an array' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Steps must be an array');
    });

    it('rejects steps with invalid URL scheme (ftp)', () => {
      const config = {
        steps: [
          { url: 'ftp://example.com/file', method: 'GET' },
          { url: 'https://example.com/page', method: 'GET' }
        ]
      };
      const result = validateTransactionConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('http or https scheme'))).toBe(true);
    });

    it('rejects steps with malformed URL', () => {
      const config = {
        steps: [
          { url: 'not-a-valid-url', method: 'GET' },
          { url: 'https://example.com', method: 'GET' }
        ]
      };
      const result = validateTransactionConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('not a well-formed URL'))).toBe(true);
    });

    it('rejects steps with missing URL', () => {
      const config = {
        steps: [
          { method: 'GET' },
          { url: 'https://example.com', method: 'GET' }
        ]
      };
      const result = validateTransactionConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('url must be a non-empty string'))).toBe(true);
    });

    it('rejects steps with invalid HTTP method', () => {
      const config = {
        steps: [
          { url: 'https://example.com', method: 'INVALID' },
          { url: 'https://example.com', method: 'GET' }
        ]
      };
      const result = validateTransactionConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("invalid HTTP method"))).toBe(true);
    });

    it('accepts all valid HTTP methods', () => {
      const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'];
      for (const method of methods) {
        const config = {
          steps: [
            { url: 'https://example.com/a', method },
            { url: 'https://example.com/b', method: 'GET' }
          ]
        };
        const result = validateTransactionConfig(config);
        expect(result.valid).toBe(true);
      }
    });

    it('is case-insensitive for HTTP methods', () => {
      const config = {
        steps: [
          { url: 'https://example.com/a', method: 'post' },
          { url: 'https://example.com/b', method: 'get' }
        ]
      };
      const result = validateTransactionConfig(config);
      expect(result.valid).toBe(true);
    });

    it('accepts http URLs', () => {
      const config = {
        steps: [
          { url: 'http://example.com/a', method: 'GET' },
          { url: 'http://example.com/b', method: 'GET' }
        ]
      };
      const result = validateTransactionConfig(config);
      expect(result.valid).toBe(true);
    });

    it('collects multiple errors from different steps', () => {
      const config = {
        steps: [
          { url: 'ftp://bad.com', method: 'INVALID' },
          { url: '', method: 'GET' },
          { url: 'https://good.com', method: 'GET' }
        ]
      };
      const result = validateTransactionConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });

    it('rejects non-object steps in array', () => {
      const config = {
        steps: [null, 'string']
      };
      const result = validateTransactionConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('must be an object'))).toBe(true);
    });
  });

  describe('executeSyntheticTransaction', () => {
    let mockDb;

    beforeEach(() => {
      // Mock the database module
      mockDb = {
        get: vi.fn(),
        all: vi.fn(),
        run: vi.fn()
      };

      vi.doMock('../../database.js', () => ({
        getDb: vi.fn().mockResolvedValue(mockDb)
      }));
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.resetModules();
    });

    it('throws error when transaction not found', async () => {
      // Re-import with mocked database
      const { getDb } = await import('../../database.js');
      vi.mocked(getDb).mockResolvedValue(mockDb);
      mockDb.get.mockResolvedValue(null);

      const { executeSyntheticTransaction: exec } = await import('../../synthetic.js');

      await expect(exec(999)).rejects.toThrow('Transaction 999 not found');
    });

    it('executes steps sequentially and records results on success', async () => {
      const { getDb } = await import('../../database.js');
      vi.mocked(getDb).mockResolvedValue(mockDb);

      mockDb.get.mockResolvedValue({ id: 1, monitor_id: 1, name: 'Test TX' });
      mockDb.all.mockImplementation((query) => {
        if (query.includes('synthetic_steps')) {
          return Promise.resolve([
            { id: 1, transaction_id: 1, step_order: 1, url: 'https://httpbin.org/get', method: 'GET', headers: null, body: null, timeout: 10, extract_rules: null, validation_rules: null },
            { id: 2, transaction_id: 1, step_order: 2, url: 'https://httpbin.org/get', method: 'GET', headers: null, body: null, timeout: 10, extract_rules: null, validation_rules: null }
          ]);
        }
        return Promise.resolve([]);
      });
      mockDb.run.mockResolvedValue({ lastID: 1 });

      // Mock global fetch
      const mockResponse = {
        status: 200,
        headers: new Headers(),
        clone: () => mockResponse,
        text: () => Promise.resolve('OK')
      };
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const { executeSyntheticTransaction: exec } = await import('../../synthetic.js');
      const result = await exec(1);

      expect(result.transaction_id).toBe(1);
      expect(result.overall_status).toBe('PASS');
      expect(result.failed_step_index).toBeNull();
      expect(result.failure_reason).toBeNull();
      expect(result.step_results.length).toBe(2);
      expect(result.step_results[0].pass).toBe(true);
      expect(result.step_results[1].pass).toBe(true);
      expect(result.total_time_ms).toBeGreaterThanOrEqual(0);
      expect(result.executed_at).toBeDefined();

      // Verify DB persistence
      expect(mockDb.run).toHaveBeenCalled();

      delete global.fetch;
    });

    it('aborts on first failure and records failed_step_index', async () => {
      const { getDb } = await import('../../database.js');
      vi.mocked(getDb).mockResolvedValue(mockDb);

      mockDb.get.mockResolvedValue({ id: 1, monitor_id: 1, name: 'Test TX' });
      mockDb.all.mockImplementation((query) => {
        if (query.includes('synthetic_steps')) {
          return Promise.resolve([
            { id: 1, transaction_id: 1, step_order: 1, url: 'https://example.com/a', method: 'GET', headers: null, body: null, timeout: 10, extract_rules: null, validation_rules: null },
            { id: 2, transaction_id: 1, step_order: 2, url: 'https://example.com/b', method: 'GET', headers: null, body: null, timeout: 10, extract_rules: null, validation_rules: null },
            { id: 3, transaction_id: 1, step_order: 3, url: 'https://example.com/c', method: 'GET', headers: null, body: null, timeout: 10, extract_rules: null, validation_rules: null }
          ]);
        }
        return Promise.resolve([]);
      });
      mockDb.run.mockResolvedValue({ lastID: 1 });

      let callCount = 0;
      global.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 2) {
          // Second step returns 500
          return Promise.resolve({
            status: 500,
            headers: new Headers(),
            clone() { return this; },
            text: () => Promise.resolve('Server Error')
          });
        }
        return Promise.resolve({
          status: 200,
          headers: new Headers(),
          clone() { return this; },
          text: () => Promise.resolve('OK')
        });
      });

      const { executeSyntheticTransaction: exec } = await import('../../synthetic.js');
      const result = await exec(1);

      expect(result.overall_status).toBe('FAIL');
      expect(result.failed_step_index).toBe(1); // Zero-based, second step
      expect(result.failure_reason).toContain('500');
      expect(result.step_results.length).toBe(2); // Third step not executed
      expect(result.step_results[0].pass).toBe(true);
      expect(result.step_results[1].pass).toBe(false);

      delete global.fetch;
    });

    it('handles timeout by aborting remaining steps', async () => {
      const { getDb } = await import('../../database.js');
      vi.mocked(getDb).mockResolvedValue(mockDb);

      mockDb.get.mockResolvedValue({ id: 1, monitor_id: 1, name: 'Test TX' });
      mockDb.all.mockImplementation((query) => {
        if (query.includes('synthetic_steps')) {
          return Promise.resolve([
            { id: 1, transaction_id: 1, step_order: 1, url: 'https://example.com/a', method: 'GET', headers: null, body: null, timeout: 1, extract_rules: null, validation_rules: null },
            { id: 2, transaction_id: 1, step_order: 2, url: 'https://example.com/b', method: 'GET', headers: null, body: null, timeout: 1, extract_rules: null, validation_rules: null }
          ]);
        }
        return Promise.resolve([]);
      });
      mockDb.run.mockResolvedValue({ lastID: 1 });

      // First step times out
      global.fetch = vi.fn().mockImplementation(() => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        return Promise.reject(error);
      });

      const { executeSyntheticTransaction: exec } = await import('../../synthetic.js');
      const result = await exec(1);

      expect(result.overall_status).toBe('FAIL');
      expect(result.failed_step_index).toBe(0);
      expect(result.failure_reason).toContain('timeout');
      expect(result.step_results.length).toBe(1); // Second step not executed

      delete global.fetch;
    });

    it('passes cookies between steps', async () => {
      const { getDb } = await import('../../database.js');
      vi.mocked(getDb).mockResolvedValue(mockDb);

      mockDb.get.mockResolvedValue({ id: 1, monitor_id: 1, name: 'Cookie TX' });
      mockDb.all.mockImplementation((query) => {
        if (query.includes('synthetic_steps')) {
          return Promise.resolve([
            { id: 1, transaction_id: 1, step_order: 1, url: 'https://example.com/login', method: 'POST', headers: null, body: null, timeout: 10, extract_rules: null, validation_rules: null },
            { id: 2, transaction_id: 1, step_order: 2, url: 'https://example.com/dashboard', method: 'GET', headers: null, body: null, timeout: 10, extract_rules: null, validation_rules: null }
          ]);
        }
        return Promise.resolve([]);
      });
      mockDb.run.mockResolvedValue({ lastID: 1 });

      let secondCallHeaders = null;
      let callCount = 0;
      global.fetch = vi.fn().mockImplementation((url, options) => {
        callCount++;
        if (callCount === 1) {
          // First step sets a cookie
          const headers = new Headers();
          headers.set('set-cookie', 'session=abc123; Path=/');
          return Promise.resolve({
            status: 200,
            headers,
            clone() { return this; },
            text: () => Promise.resolve('OK')
          });
        }
        // Second step should receive the cookie
        secondCallHeaders = options.headers;
        return Promise.resolve({
          status: 200,
          headers: new Headers(),
          clone() { return this; },
          text: () => Promise.resolve('OK')
        });
      });

      const { executeSyntheticTransaction: exec } = await import('../../synthetic.js');
      const result = await exec(1);

      expect(result.overall_status).toBe('PASS');
      expect(secondCallHeaders).toBeDefined();
      expect(secondCallHeaders['Cookie']).toContain('session=abc123');

      delete global.fetch;
    });
  });

  describe('getTransactionResults', () => {
    let mockDb;

    beforeEach(() => {
      mockDb = {
        get: vi.fn(),
        all: vi.fn(),
        run: vi.fn()
      };

      vi.doMock('../../database.js', () => ({
        getDb: vi.fn().mockResolvedValue(mockDb)
      }));
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.resetModules();
    });

    it('returns empty array when no results exist', async () => {
      const { getDb } = await import('../../database.js');
      vi.mocked(getDb).mockResolvedValue(mockDb);
      mockDb.all.mockResolvedValue([]);

      const { getTransactionResults: getResults } = await import('../../synthetic.js');
      const results = await getResults(1);

      expect(results).toEqual([]);
    });

    it('returns results with step details and correct types', async () => {
      const { getDb } = await import('../../database.js');
      vi.mocked(getDb).mockResolvedValue(mockDb);

      mockDb.all.mockImplementation((query) => {
        if (query.includes('synthetic_results')) {
          return Promise.resolve([{
            id: 1,
            transaction_id: 1,
            overall_status: 'PASS',
            failed_step_index: null,
            failure_reason: null,
            total_time_ms: 150,
            executed_at: '2024-01-01T00:00:00.000Z'
          }]);
        }
        if (query.includes('synthetic_step_results')) {
          return Promise.resolve([
            { step_index: 0, status_code: 200, response_time_ms: 80, pass: 1, error: null },
            { step_index: 1, status_code: 200, response_time_ms: 70, pass: 1, error: null }
          ]);
        }
        return Promise.resolve([]);
      });

      const { getTransactionResults: getResults } = await import('../../synthetic.js');
      const results = await getResults(1);

      expect(results.length).toBe(1);
      expect(results[0].transaction_id).toBe(1);
      expect(results[0].overall_status).toBe('PASS');
      expect(results[0].step_results.length).toBe(2);
      expect(results[0].step_results[0].pass).toBe(true); // Converted from int to boolean
      expect(results[0].step_results[1].pass).toBe(true);
    });

    it('respects limit parameter', async () => {
      const { getDb } = await import('../../database.js');
      vi.mocked(getDb).mockResolvedValue(mockDb);
      mockDb.all.mockResolvedValue([]);

      const { getTransactionResults: getResults } = await import('../../synthetic.js');
      await getResults(1, 5);

      // Verify the limit was passed to the query
      const call = mockDb.all.mock.calls[0];
      expect(call[1]).toContain(5);
    });
  });
});
