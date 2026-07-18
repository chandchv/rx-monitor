import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import WebSocket from 'ws';
import {
  initWebSocket,
  broadcast,
  getConnectedClientCount,
  closeWebSocket,
  getWss,
  RECONNECT_CONFIG
} from '../../ws-service.js';

function waitForMessage(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for message')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

function waitForClose(ws, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    const timer = setTimeout(resolve, timeoutMs);
    ws.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

/**
 * Connect a client and capture the welcome message.
 * Returns { ws, welcome } where welcome is the parsed welcome message.
 */
function connectClientWithWelcome(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);
    
    ws.once('message', (data) => {
      clearTimeout(timeout);
      const welcome = JSON.parse(data.toString());
      resolve({ ws, welcome });
    });
    
    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe('ws-service', () => {
  let server;
  let port;

  beforeAll(async () => {
    server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    initWebSocket(server);
  });

  afterAll(async () => {
    await closeWebSocket();
    await new Promise((resolve) => server.close(resolve));
  });

  describe('initWebSocket', () => {
    it('should initialize WebSocket server on the HTTP server', () => {
      const wss = getWss();
      expect(wss).not.toBeNull();
    });

    it('should not reinitialize if already initialized', () => {
      const wss1 = getWss();
      initWebSocket(server); // Call again
      const wss2 = getWss();
      expect(wss1).toBe(wss2);
    });

    it('should send welcome message on client connection', async () => {
      const { ws, welcome } = await connectClientWithWelcome(port);
      expect(welcome.event).toBe('connected');
      expect(welcome.data.message).toBe('WebSocket connection established');
      expect(welcome.data.timestamp).toBeDefined();
      ws.close();
      await waitForClose(ws);
    });
  });

  describe('getConnectedClientCount', () => {
    it('should track connected clients correctly', async () => {
      const { ws: ws1 } = await connectClientWithWelcome(port);
      const { ws: ws2 } = await connectClientWithWelcome(port);
      const count = getConnectedClientCount();
      // At least 2 clients should be connected (our two)
      expect(count).toBeGreaterThanOrEqual(2);

      ws1.close();
      await waitForClose(ws1);
      // After closing one, count should decrease
      // Small delay to let the server process the close
      await new Promise(r => setTimeout(r, 50));
      expect(getConnectedClientCount()).toBe(count - 1);

      ws2.close();
      await waitForClose(ws2);
    });
  });

  describe('broadcast', () => {
    it('should broadcast check_result to clients subscribed to all monitors', async () => {
      const { ws } = await connectClientWithWelcome(port);

      const msgPromise = waitForMessage(ws);
      broadcast('check_result', { monitor_id: 1, status: 'UP', response_time_ms: 120 });
      const msg = await msgPromise;

      expect(msg.event).toBe('check_result');
      expect(msg.data.monitor_id).toBe(1);
      expect(msg.data.status).toBe('UP');
      expect(msg.data.response_time_ms).toBe(120);
      expect(msg.timestamp).toBeDefined();
      ws.close();
      await waitForClose(ws);
    });

    it('should broadcast status_change events', async () => {
      const { ws } = await connectClientWithWelcome(port);

      const msgPromise = waitForMessage(ws);
      broadcast('status_change', { monitor_id: 2, previous: 'UP', new_status: 'DOWN' }, 2);
      const msg = await msgPromise;

      expect(msg.event).toBe('status_change');
      expect(msg.data.monitor_id).toBe(2);
      expect(msg.data.previous).toBe('UP');
      expect(msg.data.new_status).toBe('DOWN');
      ws.close();
      await waitForClose(ws);
    });

    it('should filter messages for clients with specific subscriptions', async () => {
      const { ws } = await connectClientWithWelcome(port);

      // Subscribe to monitor 5 only
      const subPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ action: 'subscribe', monitors: [5] }));
      await subPromise; // consume subscribed confirmation

      // Broadcast to monitor 1 — client should NOT receive this
      broadcast('check_result', { monitor_id: 1, status: 'UP' }, 1);

      // Broadcast to monitor 5 — client SHOULD receive this
      const msgPromise = waitForMessage(ws);
      broadcast('check_result', { monitor_id: 5, status: 'DOWN' }, 5);
      const msg = await msgPromise;

      expect(msg.data.monitor_id).toBe(5);
      ws.close();
      await waitForClose(ws);
    });

    it('should not fail when called with no connected clients', () => {
      expect(() => broadcast('check_result', { monitor_id: 1 })).not.toThrow();
    });

    it('should broadcast to clients subscribed to all when monitorFilter is provided', async () => {
      const { ws } = await connectClientWithWelcome(port);
      // Default subscription is 'all'

      const msgPromise = waitForMessage(ws);
      broadcast('check_result', { monitor_id: 99, status: 'UP' }, 99);
      const msg = await msgPromise;

      expect(msg.event).toBe('check_result');
      expect(msg.data.monitor_id).toBe(99);
      ws.close();
      await waitForClose(ws);
    });

    it('should broadcast without monitorFilter to all clients regardless of subscription', async () => {
      const { ws } = await connectClientWithWelcome(port);

      // Subscribe to specific monitors
      const subPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ action: 'subscribe', monitors: [10] }));
      await subPromise;

      // Broadcast without monitorFilter — goes to all
      const msgPromise = waitForMessage(ws);
      broadcast('incident_update', { incident_id: 42 });
      const msg = await msgPromise;

      expect(msg.event).toBe('incident_update');
      expect(msg.data.incident_id).toBe(42);
      ws.close();
      await waitForClose(ws);
    });
  });

  describe('subscription management', () => {
    it('should allow clients to subscribe to specific monitors', async () => {
      const { ws } = await connectClientWithWelcome(port);

      const msgPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ action: 'subscribe', monitors: [1, 2, 3] }));
      const msg = await msgPromise;

      expect(msg.event).toBe('subscribed');
      expect(msg.data.monitors).toEqual([1, 2, 3]);
      ws.close();
      await waitForClose(ws);
    });

    it('should allow clients to subscribe to all monitors', async () => {
      const { ws } = await connectClientWithWelcome(port);

      // First subscribe to specific
      const sub1 = waitForMessage(ws);
      ws.send(JSON.stringify({ action: 'subscribe', monitors: [1] }));
      await sub1;

      // Then subscribe back to all
      const sub2 = waitForMessage(ws);
      ws.send(JSON.stringify({ action: 'subscribe', monitors: 'all' }));
      const msg = await sub2;

      expect(msg.event).toBe('subscribed');
      expect(msg.data.monitors).toBe('all');
      ws.close();
      await waitForClose(ws);
    });

    it('should allow subscription updates without disconnecting', async () => {
      const { ws } = await connectClientWithWelcome(port);

      // Subscribe to [1, 2]
      const sub1 = waitForMessage(ws);
      ws.send(JSON.stringify({ action: 'subscribe', monitors: [1, 2] }));
      const msg1 = await sub1;
      expect(msg1.data.monitors).toEqual([1, 2]);

      // Update subscription to [3, 4] — replaces existing
      const sub2 = waitForMessage(ws);
      ws.send(JSON.stringify({ action: 'subscribe', monitors: [3, 4] }));
      const msg2 = await sub2;
      expect(msg2.data.monitors).toEqual([3, 4]);

      // Connection should still be open
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      await waitForClose(ws);
    });

    it('should allow clients to unsubscribe from all', async () => {
      const { ws } = await connectClientWithWelcome(port);

      const msgPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ action: 'unsubscribe', monitors: 'all' }));
      const msg = await msgPromise;

      expect(msg.event).toBe('unsubscribed');
      expect(msg.data.monitors).toEqual([]);
      ws.close();
      await waitForClose(ws);
    });

    it('should allow clients to unsubscribe from specific monitors', async () => {
      const { ws } = await connectClientWithWelcome(port);

      // Subscribe to specific monitors first
      const sub = waitForMessage(ws);
      ws.send(JSON.stringify({ action: 'subscribe', monitors: [1, 2, 3] }));
      await sub;

      // Unsubscribe from monitor 2
      const msgPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ action: 'unsubscribe', monitors: [2] }));
      const msg = await msgPromise;

      expect(msg.event).toBe('unsubscribed');
      expect(msg.data.monitors).toEqual([1, 3]);
      ws.close();
      await waitForClose(ws);
    });

    it('should send error for invalid monitors value', async () => {
      const { ws } = await connectClientWithWelcome(port);

      const msgPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ action: 'subscribe', monitors: 'invalid' }));
      const msg = await msgPromise;

      expect(msg.event).toBe('error');
      expect(msg.data.message).toContain('Invalid monitors value');
      ws.close();
      await waitForClose(ws);
    });

    it('should send error for unknown action', async () => {
      const { ws } = await connectClientWithWelcome(port);

      const msgPromise = waitForMessage(ws);
      ws.send(JSON.stringify({ action: 'unknown_action' }));
      const msg = await msgPromise;

      expect(msg.event).toBe('error');
      expect(msg.data.message).toContain('Unknown action');
      ws.close();
      await waitForClose(ws);
    });

    it('should send error for invalid JSON', async () => {
      const { ws } = await connectClientWithWelcome(port);

      const msgPromise = waitForMessage(ws);
      ws.send('not valid json {{{');
      const msg = await msgPromise;

      expect(msg.event).toBe('error');
      expect(msg.data.message).toBe('Invalid JSON');
      ws.close();
      await waitForClose(ws);
    });
  });

  describe('RECONNECT_CONFIG', () => {
    it('should export correct reconnection configuration', () => {
      expect(RECONNECT_CONFIG.initialDelayMs).toBe(1000);
      expect(RECONNECT_CONFIG.maxDelayMs).toBe(30000);
      expect(RECONNECT_CONFIG.maxAttempts).toBe(10);
      expect(RECONNECT_CONFIG.backoffMultiplier).toBe(2);
    });

    it('should produce correct exponential backoff sequence 1s→2s→4s→8s→16s→30s(capped)', () => {
      const delays = [];
      let delay = RECONNECT_CONFIG.initialDelayMs;
      for (let i = 0; i < RECONNECT_CONFIG.maxAttempts; i++) {
        delays.push(Math.min(delay, RECONNECT_CONFIG.maxDelayMs));
        delay *= RECONNECT_CONFIG.backoffMultiplier;
      }
      expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000]);
    });
  });

  describe('ping/pong heartbeat', () => {
    it('should set isAlive to true on initial client connection', async () => {
      const { ws } = await connectClientWithWelcome(port);

      const wss = getWss();
      const serverClients = Array.from(wss.clients);
      // At least one client should be alive
      const aliveClient = serverClients.find(c => c.isAlive === true);
      expect(aliveClient).toBeDefined();
      ws.close();
      await waitForClose(ws);
    });
  });
});
