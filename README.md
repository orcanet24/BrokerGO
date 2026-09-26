# BrokerGO

**BrokerGO realtime propio estilo Firebase (pub/sub), en Go.**  
Sin dependencia de Firebase/Parse: tú emites los JWT, tú controlas los datos, tú despliegas el enjambre.

```
Móvil / Web / Backend
        │  WSS (JSON)  ·  gRPC (protobuf)
        ▼
  ┌─────────────┐   Redis TLS+AUTH    ┌─────────────┐
  │  Nodo Go A  │◄───────────────────►│  Nodo Go B  │  … N VPS
  └─────────────┘   pub/sub + streams └─────────────┘
        ▲
   DNS round-robin  →  cualquier dispositivo llega a cualquier nodo
```

| | |
|--|--|
| **Transporte** | WSS (clientes) + gRPC (backends), TLS 1.3 con Let's Encrypt en la app |
| **Fan-out** | Redis Pub/Sub entre nodos + Streams para replay |
| **Auth** | JWT EdDSA (Ed25519) emitido **por tu backend**; ACL por canal |
| **Presencia** | ZSET por canal con TTL, refresh cada 10 s |
| **Despliegue** | Binario estático + systemd + DNS round-robin (enjambre) |
| **Estado** | Nodos stateless; el estado vive en el hub local + Redis |

---

## Valoración de usos (1–10)

Qué tan bien sirve este broker para cada tipo de carga:

| Caso de uso | Nota | Por qué |
|-------------|:----:|---------|
| Chat en tiempo real (salas, DMs vía canales) | **9** | Pub/sub nativo, presencia, replay, multi-nodo |
| Notificaciones push in-app (multi-dispositivo) | **9** | Canales por usuario (`user:{id}.*`), ACL listo |
| Sync de estado en vivo (colaborativo ligero) | **8** | Edición concurrente vía eventos; sin CRDT/DB propia |
| Dashboards / métricas en vivo | **9** | Fan-out barato, mucha suscripción, poco publish |
| Multiplayer casual / coordenación (no tick-based) | **7** | Bien para turnos/estados; no es un game engine |
| IoT / telemetría (frames pequeños, alta frecuencia) | **7** | Rate limits y 64 KB/frame; validar throughput real |
| Avisos críticos (debe llegar sí o sí) | **6** | Usa replay + acks en tu app; el broker no garantiza one-shot sin tu lógica |
| Reemplazo completo de Firebase (Auth, DB, Storage) | **4** | Solo realtime/pub-sub; auth y datos son tuyos aparte |
| Colaboración tipo Google Docs (CRDT, docs grandes) | **3** | No incluye CRDT ni persistencia de documentos |
| Streaming de vídeo/audio (media plane) | **1** | No es un SFU; usa WebRTC/mediasoup aparte |

**Resumen:** como **bus realtime multi-nodo autoalojado** es un **9/10**. Como “plataforma completa tipo Firebase” es un **4/10** a propósito (alcance: pub/sub + presencia, no DB/Auth/Storage).

---

## Ejemplos de uso

### 1. Chat (salas públicas + DMs)

```js
// Sala pública
c.subscribe("chat.sala-42", (ev) => render(ev.payload));
c.publish("chat.sala-42", { text: "hola", user: "ana" });

// DM: ACL solo permite user:emisor.* y user:receptor.*
// Backend emite JWT con channels: ["user:ana.*", "user:juan.*"]
c.subscribe("user:juan.inbox", (ev) => showDM(ev.payload));
c.publish("user:juan.inbox", { text: "hola" });
```

Canales: `chat.{sala}`, `user:{id}.inbox`.  
JWT: `channels: ["chat.*", "user:{sub}.*"]`.

### 2. Notificaciones en vivo (misma cuenta, N dispositivos)

```
Dispositivo 1 y 2 se suscriben a  user:u123.notify
Tu backend (gRPC) publica en       user:u123.notify
Ambos reciben el evento al instante
```

```go
// backend Go
_, err := client.Publish(ctx, &brokerv1.PublishRequest{
  Channel: "user:u123.notify",
  Payload: []byte(`{"title":"Pedido enviado","orderId":"A-9"}`),
})
```

### 3. Dashboard de métricas / trading / monitoring

- Suscripción: `metrics.servidor-{id}`, `trades.BTCUSDT`
- Backend o workers publican ticks; cientos de dashboards escuchan.
- Fan-out: 1 publish → N suscriptores locales en cada nodo.

### 4. Whiteboard / colaboración ligero

- Canal por lienzo: `board:{uuid}`
- Cada trazo es un evento `{type:"stroke", ...}`
- `since` en subscribe → replay de lo que el cliente se perdió al reconectar.

### 5. Multiplayer casual (lobby + estado compartido)

- `game:{matchId}.state`, `game:{matchId}.events`
- Coordinación, turnos, latencia de chat del lobby; la lógica de juego sigue en tu servidor.

### 6. IoT / telemetría (con medida)

- Dispositivos publican en `iot.device-{id}.telem`
- Paneles se suscriben con ACL restringida por tenant: `iot.tenant7.*`
- Subir `BROKER_RATE_LIMIT_PUB_PS` y medir RSS/CPU antes de escalar frecuencia.

### 7. Webhook / fan-in desde tus servicios

- Cualquier microservicio con el JWT `role=backend` publica eventos de dominio (`orders.created`, `billing.paid`).
- Frontends se suscriben solo a los canales que la ACL permite.

### 8. Enjambre multi-VPS (producción)

```
brokergo.example.com  A  →  VPS-1
                        →  VPS-2
                        →  VPS-3
DNS round-robin + Redis master/réplicas + WSS en cada nodo
```

Un nodo cae → el SDK reintenta (backoff) y cae en otro VPS.

---

## Uso del SDK (JavaScript)

```js
import { BrokerClient } from "@broker/client";

const c = new BrokerClient({
  url: "wss://broker.example.com/ws",
  token: async () => (await fetch("/api/broker-token").json()).token,
  production: true, // exige wss://
});

c.on("open", () => console.log("conectado"));
await c.connect();

c.subscribe("chat.sala1", (ev) => console.log(ev));
c.publish("chat.sala1", { text: "hola" });
c.presence("chat.sala1");
```

Reconexión: backoff exponencial + jitter → resubscribe con `since` → replay del stream.

---

## Seguridad (resumen)

- TLS 1.3 obligatorio en el proceso (autocert / Let's Encrypt), puerto 443.
- JWT **EdDSA** con `iss`/`aud`/`exp`/`kid`; denylist de `jti` en Redis.
- ACL por canal **deny-by-default** (subscribe y publish); `role=backend` solo con token de servicio.
- Límites: 64 KB/frame, conn/IP, rate limit por token bucket, `recover()` en handlers.
- Redis: TLS + AUTH, no expuesto a Internet; firewall solo 443 + SSH.

Detalle: [`docs/security.md`](docs/security.md).

---

## Arranque rápido

```bash
# Requisitos: Go 1.26+ (toolchain auto), Redis opcional en dev
make test
make keys                          # genera JWKS en ./devkeys
BROKER_LISTEN_ADDR=:8443 \
BROKER_JWT_PUBLIC_KEYS_DIR=./devkeys \
BROKER_JWT_ISSUER=http://localhost \
BROKER_ACME_ENABLED=false \
go run ./cmd/broker
```

Producción:

```bash
make dist                          # linux/amd64 estático + sha256
# en cada VPS: deploy/install-broker.sh (verifica checksum, systemd, ufw)
```

Guía completa: [`docs/deployment.md`](docs/deployment.md).

---

## Protocolo WebSocket

| Dir | Frame | Notas |
|-----|-------|--------|
| → | `{"type":"auth","token":"<JWT>"}` | primer frame obligatorio |
| → | `{"type":"subscribe","channel":"c","since":ts}` | `since` opcional → replay |
| → | `{"type":"unsubscribe","channel":"c"}` | |
| → | `{"type":"publish","channel":"c","payload":{}}` | ACL + rate limit |
| → | `{"type":"presence","channel":"c"}` | |
| → | `{"type":"ping"}` | |
| ← | `{"type":"auth_ok","sub":"...","conn":"..."}` | |
| ← | `{"type":"event","channel":"c","payload":{},"ts":...}` | |
| ← | `{"type":"sub_ok"}` / `unsub_ok` / `pong` | |
| ← | `{"type":"error","code":"forbidden","message":"..."}` | |

Canales: `^[a-zA-Z0-9._:-]{1,128}$` · Frame máx. 64 KB.

---

## Arquitectura del código

```
cmd/broker/          main: config, Redis opcional, WSS, gRPC, autocert, shutdown
internal/config/     env + secretos (archivos 0600), validación production
internal/hub/        conexiones, canales, memberships, fan-out local
internal/auth/       JWT EdDSA + ACL por patrón (deny-by-default)
internal/server/     WS, protocolo JSON, rate limits, gRPC service, presencia
internal/redisx/     bus (PSubscribe, streams/replay), denylist, ZSET presencia
proto/broker/v1/     BrokerService (Publish, SubscribeStream, Presence)
sdk/js/              cliente WebSocket (reconnect + replay)
deploy/              broker.service, install-broker.sh, env example
docs/                architecture, security, deployment, use-cases
```

---

## gRPC (backends)

```protobuf
service BrokerService {
  rpc Publish(PublishRequest) returns (PublishResponse);
  rpc SubscribeStream(SubscribeRequest) returns (stream Event);
  rpc Presence(PresenceRequest) returns (PresenceResponse);
}
```

Metadata: `authorization: Bearer <JWT role=backend>`.  
Por defecto escucha en `127.0.0.1:9090` (**no** expongas gRPC público sin mTLS/red privada).

---

## Roadmap

| Fase | Estado |
|------|--------|
| Hub, config, JWT/ACL, WSS, hardening | ✅ |
| Redis pub/sub + streams + denylist + presencia | ✅ |
| gRPC + test multi-nodo + fuzz + govulncheck 0 vulns | ✅ |
| SDK JS + deploy systemd/scripts | ✅ |
| SDK Flutter | ⏳ |
| Métricas Prometheus, mTLS gRPC, HA Redis | 🔜 |

---

## Docs

- [`docs/architecture.md`](docs/architecture.md) — enjambre, flujo de mensajes, fases  
- [`docs/security.md`](docs/security.md) — seguridad por capas  
- [`docs/deployment.md`](docs/deployment.md) — VPS, DNS, systemd, updates  
- [`docs/use-cases.md`](docs/use-cases.md) — valoraciones y ejemplos detallados  

## Licencia

MIT — ver [`LICENSE`](LICENSE).
