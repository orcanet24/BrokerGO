/**
 * Broker JS SDK — WebSocket client for the broker (wss).
 *
 * Zero dependencies. Reconnects with backoff + jitter, resubscribes and
 * replays missed events via `since`.
 *
 * Usage:
 *   const c = new BrokerClient({
 *     url: "wss://broker.example.com/ws",
 *     token: () => myBackend.getShortLivedJWT(),
 *   });
 *   await c.connect();
 *   c.subscribe("chat.sala1", (ev) => console.log(ev));
 *   c.publish("chat.sala1", { text: "hola" });
 */

const DEFAULTS = {
  url: null,
  token: null, // string or async () => string
  autoReconnect: true,
  minBackoffMs: 500,
  maxBackoffMs: 30000,
  pingIntervalMs: 15000,
  production: true, // require wss://
};

export class BrokerClient {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.ws = null;
    this.status = "disconnected"; // disconnected | connecting | connected
    this.channels = new Map(); // channel -> { handler, lastTs }
    this.handlers = { open: [], close: [], error: [], message: [] };
    this._attempt = 0;
    this._closedByUser = false;
    this._pingTimer = null;
    this._reconnectTimer = null;
    this._connectPromise = null;
  }

  on(evt, fn) {
    if (!this.handlers[evt]) throw new Error("unknown event " + evt);
    this.handlers[evt].push(fn);
    return this;
  }

  _emit(evt, ...args) {
    for (const fn of this.handlers[evt] || []) {
      try {
        fn(...args);
      } catch (_) {
        /* user handler errors must not kill the client */
      }
    }
  }

  _validateUrl(url) {
    if (!url) throw new Error("url required");
    if (this.opts.production && !url.startsWith("wss://")) {
      throw new Error("production requires wss:// (got " + url + ")");
    }
  }

  async connect() {
    this._validateUrl(this.opts.url);
    if (this.status === "connected") return;
    if (this._connectPromise) return this._connectPromise;
    this._closedByUser = false;
    this.status = "connecting";
    this._connectPromise = this._open().finally(() => {
      this._connectPromise = null;
    });
    return this._connectPromise;
  }

  async _open() {
    const token = await this._resolveToken();
    const sep = this.opts.url.includes("?") ? "&" : "?";
    const url = `${this.opts.url}${sep}sdk=js`;

    const ws = new WebSocket(url);
    this.ws = ws;

    await new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        ws.close();
        reject(new Error("websocket timeout"));
      }, 10000);
      ws.onopen = () => {
        clearTimeout(to);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(to);
        reject(new Error("websocket error"));
      };
    });

    // Auth frame first (required by broker).
    this._send({ type: "auth", token });
    const first = await this._nextMessage(ws, 10000);
    let parsed;
    try {
      parsed = JSON.parse(first);
    } catch {
      throw new Error("invalid auth response");
    }
    if (parsed.type !== "auth_ok") {
      throw new Error("auth failed: " + (parsed.message || parsed.code || "unknown"));
    }

    this.status = "connected";
    this._attempt = 0;
    this._attachListeners(ws);
    this._startPing();
    // Resubscribe all channels with replay.
    for (const [channel, meta] of this.channels) {
      this._send({
        type: "subscribe",
        channel,
        since: meta.lastTs || 0,
      });
    }
    this._emit("open", parsed);
  }

  _resolveToken() {
    const t = this.opts.token;
    if (typeof t === "function") return Promise.resolve(t());
    if (typeof t === "string" && t) return Promise.resolve(t);
    return Promise.reject(new Error("token required"));
  }

  _nextMessage(ws, timeoutMs) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("message timeout")), timeoutMs);
      const onMsg = (ev) => {
        clearTimeout(to);
        ws.removeEventListener("message", onMsg);
        resolve(ev.data);
      };
      ws.addEventListener("message", onMsg);
    });
  }

  _attachListeners(ws) {
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this._emit("message", msg);
      if (msg.type === "event" && msg.channel) {
        const meta = this.channels.get(msg.channel);
        if (meta) {
          if (msg.ts) meta.lastTs = Math.max(meta.lastTs || 0, msg.ts);
          if (meta.handler) meta.handler(msg);
        }
      }
      if (msg.type === "error") {
        this._emit("error", msg);
      }
    };
    ws.onclose = () => {
      this._stopPing();
      const was = this.status;
      this.status = "disconnected";
      this._emit("close");
      if (!this._closedByUser && this.opts.autoReconnect && was === "connected") {
        this._scheduleReconnect();
      }
    };
    ws.onerror = () => this._emit("error", { type: "socket" });
  }

  _scheduleReconnect() {
    this._attempt++;
    const exp = Math.min(
      this.opts.minBackoffMs * 2 ** this._attempt,
      this.opts.maxBackoffMs
    );
    const jitter = Math.random() * exp * 0.3;
    const delay = exp + jitter;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {
        if (!this._closedByUser) this._scheduleReconnect();
      });
    }, delay);
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this.status === "connected") this._send({ type: "ping" });
    }, this.opts.pingIntervalMs);
  }

  _stopPing() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("not connected");
    }
    this.ws.send(JSON.stringify(obj));
  }

  subscribe(channel, handler) {
    if (!channel) throw new Error("channel required");
    const meta = this.channels.get(channel) || { handler: null, lastTs: 0 };
    if (handler) meta.handler = handler;
    this.channels.set(channel, meta);
    if (this.status === "connected") {
      this._send({ type: "subscribe", channel, since: meta.lastTs || 0 });
    }
    return this;
  }

  unsubscribe(channel) {
    this.channels.delete(channel);
    if (this.status === "connected") {
      try {
        this._send({ type: "unsubscribe", channel });
      } catch (_) {}
    }
    return this;
  }

  publish(channel, payload) {
    this._send({ type: "publish", channel, payload });
    return this;
  }

  presence(channel) {
    this._send({ type: "presence", channel });
    return this;
  }

  async close() {
    this._closedByUser = true;
    clearTimeout(this._reconnectTimer);
    this._stopPing();
    if (this.ws) {
      try {
        this.ws.close(1000, "bye");
      } catch (_) {}
    }
    this.ws = null;
    this.status = "disconnected";
  }
}

export default BrokerClient;
