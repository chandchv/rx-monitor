import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', '..', 'public');

let server;
let baseUrl;

function createTestApp() {
  const app = express();

  app.get('/articles', (req, res) => {
    res.sendFile(path.join(publicDir, 'articles.html'));
  });

  app.get('/articles/:slug', (req, res) => {
    let slug = req.params.slug;
    if (!slug.endsWith('.html')) slug += '.html';
    const articlePath = path.join(publicDir, 'articles', slug);
    if (fs.existsSync(articlePath)) {
      return res.sendFile(articlePath);
    }
    res.sendFile(path.join(publicDir, 'articles.html'));
  });

  app.get(['/sitemap.xml', '/sitemaps.xml'], (req, res) => {
    res.sendFile(path.join(publicDir, 'sitemap.xml'));
  });

  app.get('/robots.txt', (req, res) => {
    res.sendFile(path.join(publicDir, 'robots.txt'));
  });

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

describe('SEO & Knowledge Hub Article Routes', () => {
  describe('GET /articles', () => {
    it('returns 200 OK with HTML content type', async () => {
      const { status, headers, text } = await fetchRoute('/articles');
      expect(status).toBe(200);
      expect(headers.get('content-type')).toContain('text/html');
      expect(text).toContain('Knowledge Hub');
    });
  });

  describe('GET /articles/uptimerobot-alternative-uptimebunny', () => {
    it('serves UptimeRobot alternative comparison article', async () => {
      const { status, text } = await fetchRoute('/articles/uptimerobot-alternative-uptimebunny');
      expect(status).toBe(200);
      expect(text).toContain('UptimeRobot Alternative');
      expect(text).toContain('UptimeBunny');
    });
  });

  describe('GET /articles/best-free-uptime-monitoring-tools', () => {
    it('serves best free uptime monitoring tools article', async () => {
      const { status, text } = await fetchRoute('/articles/best-free-uptime-monitoring-tools');
      expect(status).toBe(200);
      expect(text).toContain('Best Free Website');
      expect(text).toContain('Uptime Monitoring Tools');
    });
  });

  describe('GET /articles/free-ssl-certificate-expiry-monitoring', () => {
    it('serves free SSL certificate expiry article', async () => {
      const { status, text } = await fetchRoute('/articles/free-ssl-certificate-expiry-monitoring');
      expect(status).toBe(200);
      expect(text).toContain('Free SSL Certificate Expiry');
    });
  });

  describe('GET /articles/linux-server-monitoring-guide', () => {
    it('serves linux server monitoring article', async () => {
      const { status, text } = await fetchRoute('/articles/linux-server-monitoring-guide');
      expect(status).toBe(200);
      expect(text).toContain('Linux Server Uptime Monitoring');
      expect(text).toContain('CPU, RAM, Disk');
    });
  });

  describe('GET /articles/web-analytics-latency-apdex-guide', () => {
    it('serves web analytics latency article', async () => {
      const { status, text } = await fetchRoute('/articles/web-analytics-latency-apdex-guide');
      expect(status).toBe(200);
      expect(text).toContain('Mastering Web Analytics');
      expect(text).toContain('Apdex');
    });
  });

  describe('GET /articles/website-downtime-seo-impact-guide', () => {
    it('serves website downtime SEO article', async () => {
      const { status, text } = await fetchRoute('/articles/website-downtime-seo-impact-guide');
      expect(status).toBe(200);
      expect(text).toContain('Google SEO Rankings');
      expect(text).toContain('Googlebot');
    });
  });

  describe('GET /sitemap.xml and /sitemaps.xml', () => {
    it('returns 200 OK with sitemap xml content for both endpoints', async () => {
      const res1 = await fetchRoute('/sitemap.xml');
      const res2 = await fetchRoute('/sitemaps.xml');
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res1.text).toContain('<urlset');
      expect(res1.text).toContain('uptimerobot-alternative-uptimebunny');
    });
  });

  describe('Promo Code Security Checks', () => {
    it('ensures hardcoded BETA2026 promo code is absent from public faq.html', async () => {
      const { text } = await fetchRoute('/faq.html');
      expect(text).not.toContain('BETA2026');
      expect(text).not.toContain('UPTIMEBETA35');
    });
  });
});
