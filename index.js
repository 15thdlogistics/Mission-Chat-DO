export class Mission_Chat {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // WebSocket sessions
  }

  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      const role = request.headers.get("x-role"); // ICC | CLIENT | OPERATOR
      const missionId = url.searchParams.get("missionId");

      if (!role || !missionId) {
        return new Response("Missing role or missionId", { status: 400 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      await this.handleSession(server, role, missionId);

      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }

    // Fallback REST message send
    if (url.pathname === "/send" && request.method === "POST") {
      return this.handleMessage(request);
    }

    return new Response("Not Found", { status: 404 });
  }

  async handleSession(ws, role, missionId) {
    ws.accept();

    const sessionId = crypto.randomUUID();

    this.sessions.set(sessionId, { ws, role, missionId });

    ws.addEventListener("message", async (event) => {
      try {
        const payload = JSON.parse(event.data);
        await this.processMessage(sessionId, payload);
      } catch {
        ws.send(JSON.stringify({ error: "Invalid message format" }));
      }
    });

    ws.addEventListener("close", () => {
      this.sessions.delete(sessionId);
    });
  }

  async handleMessage(request) {
    const body = await request.json();
    const { missionId, senderRole, message } = body;

    if (!missionId || !senderRole || !message) {
      return new Response("Invalid payload", { status: 400 });
    }

    await this.broadcastMessage(missionId, senderRole, message);

    return new Response(JSON.stringify({ status: "sent" }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  async processMessage(sessionId, payload) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const { role, missionId } = session;
    const { message } = payload;

    await this.broadcastMessage(missionId, role, message);
  }

  async broadcastMessage(missionId, senderRole, message) {
    // ENFORCE COMMUNICATION POLICY

    for (const [id, session] of this.sessions.entries()) {
      if (session.missionId !== missionId) continue;

      const receiverRole = session.role;

      // Allowed:
      // ICC <-> CLIENT
      // ICC <-> OPERATOR

      const allowed =
        (senderRole === "ICC" && (receiverRole === "CLIENT" || receiverRole === "OPERATOR")) ||
        ((senderRole === "CLIENT" || senderRole === "OPERATOR") && receiverRole === "ICC");

      if (!allowed) continue;

      session.ws.send(JSON.stringify({
        from: senderRole,
        message,
        timestamp: Date.now()
      }));
    }

    // Persist message in SQLite storage
    const history = (await this.state.storage.get("history")) || [];
    history.push({
      senderRole,
      message,
      timestamp: Date.now()
    });

    await this.state.storage.put("history", history);
  }
}

export default {
  async fetch(request, env) {
    return new Response("Mission Chat Worker Running");
  }
};
