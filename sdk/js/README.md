# @broker/client

SDK JavaScript/TypeScript-friendly (sin dependencias) para el broker realtime.

```js
import { BrokerClient } from "./broker.js";

const client = new BrokerClient({
  url: "wss://broker.tudominio.com/ws",
  token: async () => (await fetch("/api/broker-token").then((r) => r.json())).token,
  production: true, // exige wss://
});

client.on("open", () => console.log("conectado"));
client.on("close", () => console.log("desconectado — reconectando…"));
client.on("error", (e) => console.warn("error", e));

await client.connect();

client.subscribe("chat.sala1", (ev) => {
  console.log(ev.channel, ev.payload, ev.ts);
});

client.publish("chat.sala1", { text: "hola" });
client.presence("chat.sala1");

// Al reconectar, reenvía `since` por canal → el broker hace replay del stream.
```

## Seguridad

- `production: true` rechaza `ws://`.
- El token JWT se renueva con tu `async token()`.
- Reintentos con backoff exponencial + jitter.
