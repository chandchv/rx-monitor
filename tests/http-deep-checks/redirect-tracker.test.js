import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { followRedirects } from '../../redirect-tracker.js';

/**
 * Creates a local HTTP server that supports configurable redirect chains
 * for testing the redirect tracker module.
 */
function createTestServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${server.address().port}`);
    const path = url.pathname;

    // Simple redirect chain: /redirect/N redirects to /redirect/(N-1) until 0
    const redirectMatch = path.match(/^\/redirect\/(\d+)$/);
    if (redirectMatch) {
      const count = parseInt(redirectMatch[1], 10);
      if (count > 0) {
        res.writeHead(302, { Location: `/redirect/${count - 1}` });
        res.end();
        return;
      }
      // count === 0, final destination
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Final destination');
      return;
    }

    // Custom status final destination
    const statusMatch = path.match(/^\/status\/(\d+)$/);
    if (statusMatch) {
      const status = parseInt(statusMatch[1], 10);
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(`Status ${status}`);
      return;
    }

    // Redirect to a specific status
    const redirectToStatusMatch = path.match(/^\/redirect-to-status\/(\d+)$/);
    if (redirectToStatusMatch) {
      const status = parseInt(redirectToStatusMatch[1], 10);
      res.writeHead(301, { Location: `/status/${status}` });
      res.end();
      return;
    }

    // Infinite redirect loop
    if (path === '/loop') {
      res.writeHead(302, { Location: '/loop' });
      res.end();
      return;
    }

    // Delayed response (for timeout testing)
    const delayMatch = path.match(/^\/delay\/(\d+)$/);
    if (delayMatch) {
      const delayMs = parseInt(delayMatch[1], 10);
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Delayed response');
      }, delayMs);
      return;
    }

    // Redirect to delayed endpoint
    if (path === '/redirect-to-delay') {
      res.writeHead(302, { Location: '/delay/15000' });
      res.end();
      return;
    }

    // Redirect with no Location header
    if (path === '/redirect-no-location') {
      res.writeHead(302);
      res.end();
      return;
    }

    // Multi-hop redirect chain with different status codes
    if (path === '/chain/start') {
      res.writeHead(301, { Location: '/chain/step2' });
      res.end();
      return;
    }
    if (path === '/chain/step2') {
      res.writeHead(302, { Location: '/chain/step3' });
      res.end();
      return;
    }
    if (path === '/chain/step3') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Chain complete');
      return;
    }

    // Default: 200 OK
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  });

  return server;
}

describe('redirect-tracker', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    server = createTestServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  describe('followRedirects', () => {
    it('should return immediately for non-redirect response', async () => {
      const result = await followRedirects(`${baseUrl}/status/200`);

      expect(result.aborted).toBe(false);
      expect(result.abort_reason).toBeNull();
      expect(result.final_url).toBe(`${baseUrl}/status/200`);
      expect(result.final_status).toBe(200);
      expect(result.hops).toHaveLength(1);
      expect(result.hops[0].url).toBe(`${baseUrl}/status/200`);
      expect(result.hops[0].status_code).toBe(200);
      expect(result.hops[0].response_time_ms).toBeGreaterThanOrEqual(0);
    });

    it('should follow a single redirect', async () => {
      const result = await followRedirects(`${baseUrl}/redirect/1`);

      expect(result.aborted).toBe(false);
      expect(result.final_url).toBe(`${baseUrl}/redirect/0`);
      expect(result.final_status).toBe(200);
      expect(result.hops).toHaveLength(2);
      expect(result.hops[0].status_code).toBe(302);
      expect(result.hops[1].status_code).toBe(200);
    });

    it('should follow a multi-hop chain with different status codes', async () => {
      const result = await followRedirects(`${baseUrl}/chain/start`);

      expect(result.aborted).toBe(false);
      expect(result.final_url).toBe(`${baseUrl}/chain/step3`);
      expect(result.final_status).toBe(200);
      expect(result.hops).toHaveLength(3);
      expect(result.hops[0].status_code).toBe(301);
      expect(result.hops[1].status_code).toBe(302);
      expect(result.hops[2].status_code).toBe(200);
    });

    it('should record response time for each hop', async () => {
      const result = await followRedirects(`${baseUrl}/redirect/2`);

      expect(result.hops).toHaveLength(3);
      for (const hop of result.hops) {
        expect(typeof hop.response_time_ms).toBe('number');
        expect(hop.response_time_ms).toBeGreaterThanOrEqual(0);
      }
    });

    it('should abort at max hops with redirect loop error', async () => {
      const result = await followRedirects(`${baseUrl}/loop`, 10);

      expect(result.aborted).toBe(true);
      expect(result.abort_reason).toContain('exceeded maximum of 10 hops');
      expect(result.hops).toHaveLength(10);
      // All hops should be 302 redirects
      for (const hop of result.hops) {
        expect(hop.status_code).toBe(302);
      }
    });

    it('should respect custom maxHops parameter', async () => {
      const result = await followRedirects(`${baseUrl}/loop`, 3);

      expect(result.aborted).toBe(true);
      expect(result.abort_reason).toContain('exceeded maximum of 3 hops');
      expect(result.hops).toHaveLength(3);
    });

    it('should abort with timeout error when a hop exceeds timeout', async () => {
      const result = await followRedirects(`${baseUrl}/delay/5000`, 10, 100);

      expect(result.aborted).toBe(true);
      expect(result.abort_reason).toContain('Timeout');
      expect(result.abort_reason).toContain(`${baseUrl}/delay/5000`);
    });

    it('should abort with timeout on intermediate redirect hop', async () => {
      const result = await followRedirects(`${baseUrl}/redirect-to-delay`, 10, 100);

      expect(result.aborted).toBe(true);
      expect(result.abort_reason).toContain('Timeout');
      // Should have recorded the first hop (the redirect)
      expect(result.hops.length).toBeGreaterThanOrEqual(1);
      expect(result.hops[0].status_code).toBe(302);
    });

    it('should evaluate final status - 2xx is success', async () => {
      const result = await followRedirects(`${baseUrl}/redirect-to-status/200`);

      expect(result.aborted).toBe(false);
      expect(result.final_status).toBe(200);
    });

    it('should evaluate final status - 4xx is failure', async () => {
      const result = await followRedirects(`${baseUrl}/redirect-to-status/404`);

      expect(result.aborted).toBe(false);
      expect(result.final_status).toBe(404);
      expect(result.hops).toHaveLength(2);
      expect(result.hops[0].status_code).toBe(301);
      expect(result.hops[1].status_code).toBe(404);
    });

    it('should evaluate final status - 5xx is failure', async () => {
      const result = await followRedirects(`${baseUrl}/redirect-to-status/500`);

      expect(result.aborted).toBe(false);
      expect(result.final_status).toBe(500);
    });

    it('should handle redirect with no Location header', async () => {
      const result = await followRedirects(`${baseUrl}/redirect-no-location`);

      expect(result.aborted).toBe(false);
      expect(result.final_status).toBe(302);
      expect(result.hops).toHaveLength(1);
    });

    it('should follow exactly N redirect hops', async () => {
      const result = await followRedirects(`${baseUrl}/redirect/5`);

      expect(result.aborted).toBe(false);
      expect(result.final_status).toBe(200);
      expect(result.hops).toHaveLength(6); // 5 redirects + 1 final
    });

    it('should use default maxHops of 10', async () => {
      // A chain of 9 redirects should complete fine
      const result = await followRedirects(`${baseUrl}/redirect/9`);

      expect(result.aborted).toBe(false);
      expect(result.final_status).toBe(200);
      expect(result.hops).toHaveLength(10); // 9 redirects + 1 final
    });

    it('should abort at exactly 10 redirect hops with default maxHops', async () => {
      // A redirect chain of 11 = 10 redirects + would need 11th, gets aborted
      const result = await followRedirects(`${baseUrl}/redirect/11`);

      expect(result.aborted).toBe(true);
      expect(result.abort_reason).toContain('exceeded maximum of 10 hops');
      expect(result.hops).toHaveLength(10);
    });
  });
});
