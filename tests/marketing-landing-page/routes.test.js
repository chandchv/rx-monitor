import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', '..', 'public');

/**
 * Integration tests for Express route changes (marketing landing page).
 * Validates: Requirements 2.1, 2.2, 2.3
 *
 * We create a minimal Express app mirroring the routing logic from server.js:
 * - GET / → public/landing.html
 * - GET /dashboard → public/index.html
 * - Static files from public/ remain accessible
 */

let server;
let baseUrl;

function createTestApp() {
  const app = express();

  // Landing page at root (matches server.js route)
  app.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, 'landing.html'));
  });

  // Dashboard route (matches server.js route)
  app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // Static file serving (matches server.js)
  app.use(express.static(publicDir));

  return app;
}

beforeAll(async () => {
  const app = createTestApp();
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

async function fetchRoute(route) {
  const res = await fetch(`${baseUrl}${route}`);
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

describe('marketing-landing-page routes', () => {
  describe('GET / — serves landing.html', () => {
    it('returns 200 status', async () => {
      const { status } = await fetchRoute('/');
      expect(status).toBe(200);
    });

    it('returns HTML content type', async () => {
      const { headers } = await fetchRoute('/');
      expect(headers.get('content-type')).toContain('text/html');
    });

    it('contains landing page identifiers (landing-nav class)', async () => {
      const { text } = await fetchRoute('/');
      expect(text).toContain('landing-nav');
    });

    it('references landing.css stylesheet', async () => {
      const { text } = await fetchRoute('/');
      expect(text).toContain('landing.css');
    });

    it('does not serve the dashboard index.html at root', async () => {
      const { text } = await fetchRoute('/');
      // The dashboard index.html would not have landing-nav
      expect(text).not.toContain('app.js');
    });
  });

  describe('GET /dashboard — serves index.html', () => {
    it('returns 200 status', async () => {
      const { status } = await fetchRoute('/dashboard');
      expect(status).toBe(200);
    });

    it('returns HTML content type', async () => {
      const { headers } = await fetchRoute('/dashboard');
      expect(headers.get('content-type')).toContain('text/html');
    });

    it('serves the existing dashboard page (index.html)', async () => {
      const { text } = await fetchRoute('/dashboard');
      // index.html is the dashboard — it should reference app.js or style.css
      expect(text).toContain('app.js');
    });

    it('does not contain landing page identifiers', async () => {
      const { text } = await fetchRoute('/dashboard');
      expect(text).not.toContain('landing-nav');
    });
  });

  describe('Static file serving — existing paths still work', () => {
    it('GET /style.css returns 200 with CSS content', async () => {
      const { status, headers } = await fetchRoute('/style.css');
      expect(status).toBe(200);
      expect(headers.get('content-type')).toContain('text/css');
    });

    it('GET /app.js returns 200 with JavaScript content', async () => {
      const { status, headers } = await fetchRoute('/app.js');
      expect(status).toBe(200);
      expect(headers.get('content-type')).toContain('javascript');
    });

    it('GET /landing.css returns 200 with CSS content', async () => {
      const { status, headers } = await fetchRoute('/landing.css');
      expect(status).toBe(200);
      expect(headers.get('content-type')).toContain('text/css');
    });
  });
});
