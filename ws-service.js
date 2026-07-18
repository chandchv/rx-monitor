import { WebSocketServer } from 'ws';

/**
 * WebSocket Real-Time Communication Service
 *
 * Provides real-time push updates to connected dashboard clients.
 * - Establishes WebSocket server alongside Express HTTP server using `ws` library
 * - Ping every 30s; close connection if no pong within 10s
 * - Broadcast check results and status changes within 2 seconds
 * - Supports client subscription to specific monitors or all
 * - Allows subscription updates without disconnecting
 * - Client reconnect: exponential backoff 1s→2s→4s→...→30s max, 10 attempts
 *
 * Events: 'check_result', 'status_change', 'incident_update', 'alert_triggered'
 * Client subscription message: { action: 'subscribe'|'unsubscribe', monitors: number[]|'all' }
 */

const PING_INTERVAL_MS = 30000; // 30 seconds
const PONG_TIMEOUT_MS = 10000;  // 10 seconds

// Reconnection config (documented for clients; server doesn't enforce reconnection itself)
export const RECONNECT_CONFIG = {
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  maxAttempts: 10,
  backoffMultiplier: 2
};

let wss = null;
let pingInterval = null;

/**
 * Initialize the WebSocket server on top of an existing HTTP server.
 *
 * @param {import('http').Server} httpServer - The Node.js HTTP server instance
 */
export function initWebSocket(httpServer) {
  if (wss) {
    return; // Already initialized
  }

  wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    // Default subscription: all monitors
    ws.subscriptions = 'all';
    ws.isAlive = true;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data) => {
      handleClientMessage(ws, data);
    });

    ws.on('error', (err) => {
      console.error('[ws-service] Client connection error:', err.message);
    });

    // Send a welcome message so client knows connection is established
    sendToClient(ws, {
      event: 'connected',
      data: { message: 'WebSocket connection established', timestamp: new Date().toISOString() }
    });
  });

  // Start heartbeat ping interval
  pingInterval = setInterval(() => {
    if (!wss) return;

    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        // No pong received within the last interval — terminate
        ws.terminate();
        continue;
      }

      // Mark as not alive, wait for pong
      ws.isAlive = false;
      ws.ping();

      // Set a timeout: if no pong within PONG_TIMEOUT_MS, terminate
      const pongTimer = setTimeout(() => {
        if (!ws.isAlive) {
          ws.terminate();
        }
      }, PONG_TIMEOUT_MS);
      pongTimer.unref(); // Don't keep the process alive for this timer

      // If pong arrives, clear the timer
      ws.once('pong', () => {
        clearTimeout(pongTimer);
      });
    }
  }, PING_INTERVAL_MS);
  pingInterval.unref(); // Don't keep the process alive for the ping interval

  wss.on('close', () => {
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
  });
}

/**
 * Broadcast an event to all connected clients that are subscribed to the relevant monitor(s).
 *
 * @param {string} event - Event type: 'check_result', 'status_change', 'incident_update', 'alert_triggered'
 * @param {object} data - Event payload (should include monitor_id for filtering)
 * @param {number|number[]|null} [monitorFilter] - Monitor ID(s) to target, or null/undefined for all
 */
export function broadcast(event, data, monitorFilter) {
  if (!wss) return;

  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });

  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue; // WebSocket.OPEN = 1

    // Check if client is subscribed to this monitor
    if (monitorFilter != null && ws.subscriptions !== 'all') {
      const filterIds = Array.isArray(monitorFilter) ? monitorFilter : [monitorFilter];
      const subscribed = filterIds.some(id => ws.subscriptions.includes(id));
      if (!subscribed) continue;
    }

    ws.send(message);
  }
}

/**
 * Get the number of currently connected WebSocket clients.
 *
 * @returns {number} Connected client count
 */
export function getConnectedClientCount() {
  if (!wss) return 0;
  return wss.clients.size;
}

/**
 * Gracefully shut down the WebSocket server.
 * Closes all connections and clears the ping interval.
 *
 * @returns {Promise<void>}
 */
export function closeWebSocket() {
  return new Promise((resolve) => {
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }

    if (!wss) {
      resolve();
      return;
    }

    // Close all client connections
    for (const ws of wss.clients) {
      ws.close(1001, 'Server shutting down');
    }

    wss.close(() => {
      wss = null;
      resolve();
    });
  });
}

/**
 * Get the underlying WebSocketServer instance (for testing purposes).
 *
 * @returns {WebSocketServer|null}
 */
export function getWss() {
  return wss;
}

// --- Internal helpers ---

/**
 * Handle incoming messages from a client.
 * Supports subscription management: { action: 'subscribe'|'unsubscribe', monitors: number[]|'all' }
 *
 * @param {import('ws').WebSocket} ws - The client WebSocket
 * @param {Buffer|string} rawData - Raw message data
 */
function handleClientMessage(ws, rawData) {
  let msg;
  try {
    msg = JSON.parse(rawData.toString());
  } catch {
    sendToClient(ws, { event: 'error', data: { message: 'Invalid JSON' } });
    return;
  }

  const { action, monitors } = msg;

  if (action === 'subscribe') {
    if (monitors === 'all') {
      ws.subscriptions = 'all';
    } else if (Array.isArray(monitors) && monitors.every(m => typeof m === 'number')) {
      // Replace current subscriptions with the new set
      ws.subscriptions = monitors;
    } else {
      sendToClient(ws, {
        event: 'error',
        data: { message: 'Invalid monitors value. Expected number[] or "all".' }
      });
      return;
    }

    sendToClient(ws, {
      event: 'subscribed',
      data: { monitors: ws.subscriptions }
    });
  } else if (action === 'unsubscribe') {
    if (monitors === 'all') {
      // Unsubscribe from all = no subscriptions (empty array)
      ws.subscriptions = [];
    } else if (Array.isArray(monitors) && monitors.every(m => typeof m === 'number')) {
      // Remove specific monitors from current subscriptions
      if (ws.subscriptions === 'all') {
        // Can't unsubscribe specific monitors from "all" — client should subscribe to specific ones first
        sendToClient(ws, {
          event: 'error',
          data: { message: 'Cannot unsubscribe specific monitors while subscribed to "all". Subscribe to specific monitors first.' }
        });
        return;
      }
      ws.subscriptions = ws.subscriptions.filter(id => !monitors.includes(id));
    } else {
      sendToClient(ws, {
        event: 'error',
        data: { message: 'Invalid monitors value. Expected number[] or "all".' }
      });
      return;
    }

    sendToClient(ws, {
      event: 'unsubscribed',
      data: { monitors: ws.subscriptions }
    });
  } else {
    sendToClient(ws, {
      event: 'error',
      data: { message: `Unknown action: ${action}. Expected "subscribe" or "unsubscribe".` }
    });
  }
}

/**
 * Send a JSON message to a single client.
 *
 * @param {import('ws').WebSocket} ws - The client WebSocket
 * @param {object} payload - Data to send
 */
function sendToClient(ws, payload) {
  if (ws.readyState === 1) { // WebSocket.OPEN
    ws.send(JSON.stringify(payload));
  }
}
