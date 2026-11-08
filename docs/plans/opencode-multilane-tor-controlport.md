# Plan v2: OpenCode Free-Tier Reliability với Multi-Lane Tor & ControlPort Auto-Rotation

> **⛔ SUPERSEDED — 2026-10-21.** Không còn dùng OpenCode free tier; route đang dùng là
> combo `openrouter-minimax-m3.1-flash` (→ OpenRouter `minimax/minimax-m3.1-flash:free`).
> Phase 0 (task T1) đã chạy: **0/220 request là 403**, 429 chỉ xảy ra ở
> `oc/glm-5.3-flash-free` và là capacity theo model (không theo IP); Tor không tạo được
> circuit. Gate §5.4 → **dừng workstream T2–T9**. Số liệu:
> [opencode-tor-baseline.md](opencode-tor-baseline.md). Giữ file này chỉ để tra cứu lịch sử.

**Trạng thái:** Superseded (trước đây: Draft để review, chưa implement)  
**Ngày:** 2026-10-19  
**Thay thế:** Plan v1 (trong chat)  
**Yêu cầu giữ nguyên:** pool 10 cổng Tor `9100-9109`, multi-lane race, ControlPort `9051` NEWNYM, cooldown 30s theo cổng, direct fallback, chạy nhiều agent song song.

---

## 0. TL;DR

Plan v1 có bốn lỗi chặn:

1. **Giả định 403 là do IP chưa được chứng minh.** Probe thực tế cho thấy ít nhất một lớp 403 là client-contract: direct và Tor 9100 trả cùng một body `FreeTierError: "OpenCode's free tier can only be used from within OpenCode"`. Tor không sửa được lớp này.
2. **Pool 10 cổng Tor đang bị tắt.** 9router có 10 proxy entry và 10 OpenCode connection round-robin, nhưng cả 10 connection có `connectionProxyEnabled=0`; global outbound proxy cũng `false`. Các request đang đi direct.
3. **Full-request hedge đốt gấp đôi upstream load.** `MAX_CONCURRENT_OPENCODE=1` và `MIN_REQUEST_INTERVAL_MS=2500`, không phải 2. Race 2 POST không tăng throughput, chỉ tăng token và tín hiệu abuse.
4. **Đoạn tunnel v1 không chạy.** `request({ socket })` bị Node bỏ qua; cần `tls.connect` + `createConnection`.

Plan v2 vẫn giữ đủ tính năng yêu cầu, nhưng đổi cách hiện thực:

- **Native per-connection proxy trước**, code patch sau.
- **Tunnel race** (đua CONNECT + TLS, chỉ gửi POST một lần) + **serial failover** khi response lỗi.
- **NEWNYM chỉ khi** 403 thuộc lớp abuse/rate-limit và vượt ngưỡng (xem 3.4), không phải mỗi lần lỗi.
- **Real `Response`**, không dùng fake object/`tee()`.
- **Vitest + fake CONNECT proxy/upstream**, không test live trong `npm test`.
- **Patch manager** apply/revert/verify, chịu được 9router update.
- **Base patch snapshot**: 9router gốc không có `fetchDirectSmart`; update xóa cả base lẫn Tor adapter. `apply.mjs` phải restore base trước, không chỉ chèn adapter.

> Nếu Phase 0 kết luận 403 chủ yếu là client-contract, Tor workstream dừng. Khi đó critical path là contract compatibility, không phải IP rotation.

---

## 1. Context & Goal

### 1.1 Problem

Khi chạy nhiều agent song song (Claude Code, Antigravity), request đi qua 9router tới OpenCode free tier (`oc/glm-5.3-flash-free`) và gặp:

- **403 FreeTierError:** có ít nhất hai lớp:
  - client-contract: upstream kiểm tra request có đến từ OpenCode client hay không.
  - abuse/rate: upstream gắn cờ lưu lượng hoặc IP.
- **429 Rate Limit:** theo IP, session, hoặc account/quota.
- **Hệ quả:** executor retry tới 15 lần với backoff 1-8s, budget 180s; agent bị treo, token bị đốt, log không đủ để biết lớp lỗi.

Hiện trạng đã có:

- 10 HTTPTunnelPort `9100-9109`, ControlPort `9051`, SocksPort `9050`.
- 10 `proxyPools` trong 9router, 10 OpenCode connection round-robin.
- `compactOpenCodeContext` để giảm prompt.
- 5 file backup của chunk `5330.js`, chứng tỏ đã patch nhiều lần.

### 1.2 User Story

> Là một developer chạy nhiều agent song song, tôi muốn request OpenCode free tier thành công ổn định và fail nhanh khi không thể, để agent không bị treo 180s và không đốt token vào retry vô ích.

### 1.3 Goals

| ID | Goal | Đo bằng |
|---|---|---|
| G1 | Phân loại đúng 403/429 và fail-fast lớp không retry được | classifier + log |
| G2 | Dùng đủ 10 Tor exit qua native proxy, không duplicate request | upstream/client ratio = 1.0 |
| G3 | Multi-lane tunnel race giảm tail latency | p95 TTFB |
| G4 | Serial failover tăng success rate khi một exit lỗi | 403/429 rate |
| G5 | NEWNYM có kỷ luật, không xoay cả pool vô ích | newnym count/10 phút |
| G6 | Test và rollback chịu được 9router update | apply/revert/verify |
| G7 | Đo trước/sau, acceptance nhị phân | benchmark report |

### 1.4 Non-goals

- Không cố lách client attestation của OpenCode. Nếu 403 là client-contract, đó là bug contract cần sửa, không phải bài toán IP.
- Không tăng `MAX_CONCURRENT_OPENCODE` trong cùng thay đổi này. Tăng concurrency là experiment riêng sau khi có baseline.
- Không viết lại 9router, không thay OpenCode provider.
- Không dùng IP rotation để xử lý 429 do quota/account.
- Không sửa `tests/test_opencode_compactor.cjs`; đó là test thủ công của patch compaction, không thuộc plan này.
- Không thêm dependency mới. `undici` có trong `package.json` của 9router nhưng không resolve được từ app; dùng built-in `http`, `https`, `tls`, `net`, `stream`.

### 1.5 Success Metrics

Điền baseline sau Phase 0. Target tạm:

| Metric | Target |
|---|---|
| client-contract retries | 0 |
| duplicate upstream generations (tunnel mode) | 0 |
| abuse 403 | < 5% ở concurrency 4 |
| 429 | < 2% ở concurrency 4 |
| p95 TTFB | < 8s |
| test suite | 100% pass |
| patch idempotent | apply 2 lần = no-op |

---

## 2. Evidence From Audit

### 2.1 Live Probe: 403 Không Phải Lúc Nào Cũng Do IP

Cùng một request tối thiểu tới `https://opencode.ai/zen/v1/chat/completions`, một lần direct, một lần qua Tor 9100:

```text
DIRECT   -> 403 {"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode..."}}
TOR 9100 -> 403 same body
```

Kết luận: tồn tại lớp 403 **client-contract**, không đổi được bằng NEWNYM/cooldown/IP. 9router hôm nay có 648 request `ok`, nên đường 9router đang dùng khác với curl probe. Phải capture đúng request thất bại từ 9router trước khi kết luận.

### 2.2 Tor Pool Behavior

Các probe với `check.torproject.org/api/ip`:

| Test | Kết quả |
|---|---|
| 9100 x3 liên tiếp | cùng IP `185.220.101.33` |
| 9101 / 9102 / 9103 | `23.137.255.85` / `109.70.100.6` / `192.42.116.47` |
| 9100 với `userA` / `userB` | `185.220.101.4` / `185.220.101.35` |

Hệ quả:

- Mỗi port có exit riêng và ổn định trong thời gian ngắn. Per-port cooldown là hợp lý.
- `Proxy-Authorization` tạo stream isolation, nhưng **không cần** nếu đã pin port. Nếu dùng auth, phải dùng username cố định cho mỗi port; username random mỗi request sẽ tạo circuit mới và làm cooldown vô nghĩa.

### 2.3 9router Runtime & Config

Từ [data.sqlite](/Users/hoangson/.9router/db/data.sqlite):

```text
proxyPools: 10 entry tor-pool-01..10, isActive=1
providerConnections opencode: 10 connection, rotateStrategy=round-robin
connectionProxyEnabled=0 cho cả 10
outboundProxyEnabled=false, outboundProxyUrl=http://127.0.0.1:9100
usageDaily 2026-10-19: opencode 808 request, 33.471.143 prompt tokens (~41k/request)
usageHistory 2026-10-19: 648 ok, 0 non-ok
usageHistory 2026-10-18: 1535 ok, 0 non-ok
requestDetails: rỗng
```

Hệ quả:

- 10 Tor proxy đang bị tắt. Request đi direct.
- Nếu bật global `outboundProxyEnabled` với URL 9100, **tất cả** request đi qua một exit cố định. Đây là kiểu "IP Tor cố định" dễ bị 403.
- Cách đúng là bật `connectionProxyEnabled=1` cho từng connection, mỗi connection một port `9100-9109`, giữ global proxy tắt.
- `usageHistory` chỉ có `ok`; không có baseline 403/429. Cần log failure trước khi đo.

### 2.4 Code State

Trong [5330.js](/Users/hoangson/.local/lib/node_modules/9router/app/.next-cli-build/server/chunks/5330.js):

```text
MAX_CONCURRENT_OPENCODE = 1
MIN_REQUEST_INTERVAL_MS = 2500
TOTAL_BUDGET_MS = 180000
MAX_ATTEMPT_TTFT_MS = 12000
BACKOFF_SCHEDULE = 15 entries (1s..8s)
fetchDirectSmart = https.request thủ công + Readable.toWeb().tee() + fake Response
```

Probe: cả 5 backup gốc (`.bak`, `.bak2`, `.bak_recovery`, `.clean_bak`, `.orig.bak`) đều không có `fetchDirectSmart`, `MAX_CONCURRENT_OPENCODE`, `BACKOFF_SCHEDULE`, `compactOpenCodeContext`. Đây là code custom từ các patch trước, không phải 9router gốc. Vì vậy `apply.mjs` phải có base snapshot/patch, không chỉ Tor adapter.

Các điểm cần sửa:

- 15 retry là quá nhiều, đặc biệt với 403 client-contract.
- `fetchDirectSmart` đã là seam tốt; không cần viết lại toàn bộ response handling.
- Chunk đã được rebuild ít nhất một lần; helper `_notifyTorNewnym` từ patch 01:04 đã biến mất khỏi chunk hiện tại. Hand-edit sẽ mất khi update.

### 2.5 403 Taxonomy

| Class | Dấu hiệu | Retry? | Cooldown port? | NEWNYM? | Hành động |
|---|---|---|---|---|---|
| `client_contract` | body có `only be used from within OpenCode` / `Download it at` | Không | Không | Không | fail-fast, sửa contract |
| `abuse_ip` | body có `abusive traffic` | Có, tối đa 3 lane | Có, 30s | Có, nếu pool cạn | đổi exit |
| `free_models_unavailable` | body có `free models` (chưa chắc là abuse) | Không | Không | Không | kiểm tra model availability |
| `rate_limit` | 429, `Retry-After`, `reset after` | Có, có backoff | Có, 30s | Chỉ khi 3 lane đều 429 | backoff + đổi lane |
| `cloudflare` | 403 + `cf-ray` + HTML | Có, 1-2 lane | Có, 10s | Không | đổi lane |
| `network` | ECONNRESET, timeout, TLS error | Có | Có, 10s | Không | đổi lane |
| `upstream_5xx` | 500-504 | Có, 1-2 lane | Có, 10s | Không | đổi lane |

`client_contract` là lớp quan trọng nhất: không được cooldown port, không được NEWNYM, không được retry 15 lần.

### 2.6 Unknowns

- Lớp 403 nào chiếm đa số trong workload thật?
- 9router dùng endpoint nào cho `glm-5.3-flash-free` (`/inference/v1/responses`, `/zen/v1/...`, hay đường khác)?
- Native per-connection proxy của 9router có nói chuyện đúng với Tor HTTP CONNECT không?
- 9router chạy single process hay multi-worker?
- 429 reset format thực tế là gì?
- Upstream có kiểm tra TLS fingerprint không? Nếu có, code-level Tor không sửa được client-contract.
- 9router process có supervisor không, hay phải restart thủ công? → Có: launchd `com.hoangson.9router` (KeepAlive) + watchdog `com.hoangson.9router-watchdog` (health 3s, restart bằng `launchctl kickstart -k`; xem `scripts/gateway-watchdog/`).

---

## 3. Architecture

### 3.1 Current vs Target

Hiện tại:

```text
Agent(s) -> 9router :20128 -> OpencodeExecutor -> fetchDirectSmart -> opencode.ai
                                      |
                                      +-- 10 connections round-robin
                                          connectionProxyUrl 910x, nhưng proxy disabled
```

Target:

```text
Agent(s) -> 9router :20128 -> OpencodeExecutor -> fetchWithTorFailover
                                                        |
                                                        +-- tunnel race 9100/9101 -> TLS -> POST (1 lần)
                                                        +-- serial failover 9102..9109 nếu response lỗi
                                                        +-- direct fallback nếu pool cạn
                                                        |
                                              ControlPort 9051 <- NEWNYM (có điều kiện)
```

### 3.2 Layers

| Layer | Thành phần | Trách nhiệm |
|---|---|---|
| L0 | 9router native proxy | 10 connection × 10 port, round-robin, không code |
| L1 | Adapter trong `5330.js` | thay `fetchDirectSmart` bằng module, fallback nếu module lỗi |
| L2 | `tor-race-core.cjs` | chọn port, tunnel race, failover, classify, cooldown |
| L3 | ControlPort client | AUTHENTICATE, SIGNAL NEWNYM, debounce, clear cooldown |
| L4 | Observability + patch manager | JSON log, stats, apply/revert/verify |

### 3.3 Race Semantics

Plan v2 tách hai khái niệm:

1. **Tunnel race (default):** đua 2 kết nối CONNECT + TLS tới cùng target qua 2 port. Cổng nào thiết lập xong trước thì gửi **một** POST trên cổng đó. Cổng thua bị destroy. Không gửi POST 2 lần.
2. **Request failover (serial):** nếu response trên cổng thắng là 403/429/5xx/network, thử cổng kế tiếp, tối đa 3 cổng. Đây là retry có chủ đích, không phải hedge.

Lý do:

- Tor circuit setup là phần chậm và hay fail; đua nó có lợi về latency.
- POST chat completion không idempotent; gửi 2 lần có thể generate 2 lần, tốn token và tăng abuse signal.
- Serial failover đạt reliability mà không nhân đôi upstream load.

**Full-request hedge (optional, default off):** `TOR_RACE_MODE=full` gửi 2 POST song song, first 2xx thắng, abort loser. Chỉ dùng để experiment, có warning: loser vẫn có thể đã generate token; không dùng cho production free tier.

Nếu tunnel race không cải thiện p95 so với 1 lane, đặt `TOR_RACE_LANES=1`. Race chỉ là optimization; failover mới là reliability.

### 3.4 State Machine: Cooldown & NEWNYM

```text
Request
  |
  +-- pool.select(2) -> [] ------------------------------> direct fallback
  |
  +-- tunnel race -> winner
  |     |
  |     +-- response ok --------------------------------> success, reset port
  |     |
  |     +-- client_contract / free_models_unavailable --> return ngay, không cooldown, không NEWNYM
  |     |
  |     +-- abuse_ip / rate_limit / network / 5xx
  |           |
  |           +-- cooldown port (30s / 10s)
  |           +-- còn lane? -> thử lane kế (tối đa 3)
  |           +-- abuse_ip + pool cạn healthy, hoặc rate_limit + 3 lane -> NEWNYM (debounce 10s)
  |                 |
  |                 +-- success -> clear tất cả cooldown
  |                 +-- fail -> giữ cooldown, log
  |
  +-- hết lane -> direct fallback (circuit breaker 60s)
```

Quy tắc:

- `client_contract` / `free_models_unavailable`: không cooldown, không NEWNYM, không retry.
- `abuse_ip`: cooldown 30s; NEWNYM chỉ khi `healthyPorts < 2`.
- `rate_limit`: cooldown 30s; ưu tiên `Retry-After`; NEWNYM chỉ khi 3 lane đều 429.
- `cloudflare` / `network` / `5xx`: cooldown 10s; không NEWNYM.
- NEWNYM thành công: clear toàn bộ cooldown vì tất cả circuit đã đổi.
- NEWNYM thất bại: giữ cooldown, log, không crash.

### 3.5 Response Contract

Module trả về **real `Response`**:

```js
new Response(Readable.toWeb(res), {
  status: res.statusCode,
  statusText: res.statusMessage,
  headers: filteredHeaders,
})
```

- 200/SSE: body stream được trả nguyên, không đọc, không `tee()`.
- 403/429: đọc tối đa 8KB để classify, rồi tạo `Response` mới từ text. Body lỗi nhỏ, không ảnh hưởng stream.
- Strip hop-by-hop headers: `connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`.
- Nếu request có `Accept-Encoding`, phải decompress hoặc strip; mặc định 9router không gửi, nên path hiện tại không cần.
- Không gắn metadata vào header (tránh leak ra client). Dùng property non-enumerable `__tor` trên Response.
- `clone()`, `text()`, `json()` hoạt động đúng vì là Response thật.

### 3.6 Patch Strategy

Có **hai lớp patch**, không phải một:

| Layer | Nội dung | Nguồn | Ghi chú |
|---|---|---|---|
| A. Base OpenCode patch | `fetchDirectSmart`, `compactOpenCodeContext`, semaphore, retry policy | snapshot/patch từ chunk hiện tại; `~/.config/9router/opencode-glm-free.patch`, `mod4493_optimized.js` | clean 9router không có |
| B. Tor adapter | wrapper `fetchDirectSmart` -> module | `scripts/9router-tor/apply.mjs` | plan này |

Vì 9router gốc không có `fetchDirectSmart`, `apply.mjs` phải:

1. Check layer A markers (`fetchDirectSmart`, `compactOpenCodeContext`).
2. Nếu thiếu, restore từ `base/` snapshot/patch khớp version, hoặc dừng với hướng dẫn.
3. Chỉ sau đó mới chèn layer B.

Không được giả định "update 9router xong chạy `apply.mjs` là xong". Update sẽ xóa cả base lẫn Tor adapter.

`base/manifest.json` ghi 9router version, chunk id, sha256; `apply.mjs` chỉ restore base khi khớp. Pin 9router version; chỉ update sau khi tạo base snapshot mới.

```text
scripts/9router-tor/
  ├── base/
  │   ├── 5330.base.js       # known-good base snapshot, version-pinned
  │   ├── opencode-base.patch
  │   └── manifest.json      # 9router version + sha256
  ├── tor-race-core.cjs      # runtime module, versioned trong repo
  ├── apply.mjs              # ensure base, backup, chèn adapter, copy module
  ├── revert.mjs             # restore backup trước Tor adapter
  ├── verify.mjs             # check base marker, Tor marker, syntax, module hash
  └── README.md              # runbook clean-install + update
```

Adapter trong chunk rất mỏng:

```js
function fetchDirectSmart(url, opts) {
  if (!_torRace || process.env.TOR_RACE_MODE === "off") {
    return fetchDirectSmartDirect(url, opts);
  }
  return _torRace.fetchWithTorFailover(url, opts, {
    directFetch: fetchDirectSmartDirect,
  });
}
```

Phần phức tạp nằm ngoài chunk, nhưng **base patch vẫn phải được bảo toàn**. Update 9router không chỉ cần chạy lại `apply.mjs`; nếu bản mới không khớp base manifest, `apply.mjs` phải dừng và yêu cầu tạo base patch mới.

---

## 4. Component Design

### 4.1 Module API

File: `scripts/9router-tor/tor-race-core.cjs`

```js
module.exports = {
  fetchWithTorFailover, // (url, opts, overrides) => Promise<Response>
  getStats,             // () => Stats
  close,                // () => void
};
```

`overrides` chỉ dùng cho test và adapter:

| Field | Default | Mục đích |
|---|---|---|
| `directFetch` | `null` | fallback do adapter truyền vào |
| `torPorts` | env `TOR_RACE_PORTS` hoặc `9100..9109` | test inject port |
| `controlPort` | env `TOR_CONTROL_PORT` hoặc `9051` | test inject |
| `mode` | env `TOR_RACE_MODE` hoặc `tunnel` | `off`, `tunnel`, `full` |
| `now` | `Date.now` | fake clock |
| `random` | `Math.random` | deterministic test |
| `cooldownMs` | `30000` | test |
| `newnymDebounceMs` | `10000` | test |

Production không truyền `overrides`; module đọc env/defaults.

### 4.2 `fetchWithTorFailover` Algorithm

```text
1. Nếu opts.signal đã abort -> reject.
2. Serialize body một lần: string hoặc JSON.stringify(plain object).
   Nếu body là stream/FormData -> return directFetchFinal("unsupported_body").
3. ports = pool.select(TOR_RACE_LANES)
   Nếu rỗng -> return directFetchFinal("pool_empty").
4. Nếu mode = tunnel:
     winner = raceTunnels(ports, url.hostname, url.port || 443, opts.signal, TOR_LANE_TIMEOUT_MS)
     res = requestOnSocket(winner.socket, url, opts, body)
   Nếu mode = full:
     res = raceFullRequests(ports limit 2)   // opt-in
5. classify(res)
6. Nếu ok -> pool.success(winner.port); return res.
7. Nếu client_contract hoặc free_models_unavailable -> return res ngay; không retry.
8. pool.fail(winner.port, class)
9. Nếu còn port healthy và attempts < TOR_MAX_ATTEMPTS:
     thử port kế (tunnel mới, POST một lần)
10. Nếu hết:
     Nếu shouldNewnym(class, pool, attempts) -> await maybeNewnym()
     Nếu TOR_DIRECT_FALLBACK=1 -> return directFetchFinal("lanes_exhausted")
     Return last response, gắn __tor.final = true
```

- `directFetchFinal(reason)` gọi `directFetch`, classify response, gắn `__tor = { cls, final: true, port: "direct", attempts }`, log, return. Mọi direct fallback **bên trong module** dùng hàm này.
- Direct fallback dùng circuit breaker 60s: sau 3 lần fail liên tiếp, trả last response, không thử direct cho đến khi hết 60s.

### 4.3 `openTunnel`: CONNECT + TLS

Pattern đã verify: `https.request({ socket })` bị bỏ qua; `https.request({ createConnection })` với TLS socket đã established hoạt động.

```js
const http = require("http");
const https = require("https");
const tls = require("tls");
const { once } = require("events");

async function openTunnel(port, host, targetPort, signal) {
  let tlsSocket;
  const proxyReq = http.request({
    host: "127.0.0.1",
    port,
    method: "CONNECT",
    path: `${host}:${targetPort}`,
    headers: { Host: `${host}:${targetPort}` },
    signal,
  });

  const onAbort = () => {
    proxyReq.destroy();
    tlsSocket?.destroy();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const connectPromise = once(proxyReq, "connect");
    proxyReq.end(); // BẮT BUỘC: http.request không tự gửi CONNECT nếu thiếu end()
    const [proxyRes, socket, head] = await connectPromise;
    if (proxyRes.statusCode !== 200) {
      socket.destroy();
      throw new Error(`CONNECT ${port} -> ${proxyRes.statusCode}`);
    }
    if (head && head.length) socket.unshift(head);

    tlsSocket = tls.connect({
      socket,
      servername: host,
      ALPNProtocols: ["http/1.1"],
    });
    await once(tlsSocket, "secureConnect");
    if (signal?.aborted) {
      tlsSocket.destroy();
      throw signal.reason || new Error("aborted");
    }
    return tlsSocket;
  } catch (err) {
    proxyReq.destroy();
    tlsSocket?.destroy();
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
```

Gửi request trên tunnel:

```js
const req = https.request({
  createConnection: () => tlsSocket,
  agent: false,
  host,
  port: targetPort,
  path: url.pathname + url.search,
  method: opts.method || "POST",
  headers: { ...headers, Connection: "close" },
  signal,
}, (res) => {
  res.once("close", () => tlsSocket.destroy());
  resolve(toResponse(res));
});
req.once("error", () => tlsSocket.destroy());
```

Lưu ý:

- Cleanup `req`/`res` để tránh half-open `tlsSocket` khi SSE bị client hủy hoặc upstream ngắt giữa chừng.
- Không dùng `request({ socket })`; đã test với `http.request` và Node bỏ qua `socket`. `https.request` dùng cùng client core, nên cũng không có option này.
- `agent: false` + `createConnection` trả TLS socket đã verify với HTTPS fixture.
- `targetPort` là `url.port || 443`; production luôn 443, test inject port của fake upstream. Không hardcode 443 trong CONNECT path.
- Set `Content-Length` từ body đã serialize; xóa `content-length` cũ (case-insensitive) trước khi set.
- Set `ALPNProtocols: ["http/1.1"]` để tránh server chọn h2 mà `https.request` không nói được.
- Timeout từng lane: `AbortSignal.any([parent, AbortSignal.timeout(ms)])`; destroy socket trong `finally`.
- Check `signal.aborted` sau `openTunnel` và trước khi gửi; nếu đã abort, destroy socket.
- Request cũng cần timeout: `signal: opts.signal || AbortSignal.timeout(TOR_LANE_TIMEOUT_MS)`.
- Không set `Proxy-Authorization` mặc định. Nếu cần stream isolation, dùng username cố định theo port.

### 4.4 Tunnel Race

```js
async function raceTunnels(ports, host, targetPort, parentSignal, laneTimeoutMs = 12000) {
  const controllers = ports.map(() => new AbortController());
  const attempts = ports.map((port, i) => {
    const laneSignal = AbortSignal.any(
      [parentSignal, controllers[i].signal, AbortSignal.timeout(laneTimeoutMs)].filter(Boolean)
    );
    return openTunnel(port, host, targetPort, laneSignal)
      .then((socket) => ({ port, socket, index: i }));
  });

  try {
    const winner = await Promise.any(attempts);
    controllers.forEach((c, i) => {
      if (i !== winner.index) c.abort();
    });
    attempts.forEach((p) => {
      p.then((r) => {
        if (r.index !== winner.index) r.socket.destroy();
      }).catch(() => {});
    });
    return winner;
  } catch (err) {
    controllers.forEach((c) => c.abort());
    throw err;
  }
}
```

- `Promise.any` resolve first fulfilled; loser rejections được `Promise.any` handle, không unhandled.
- `AbortSignal.any([undefined, ...])` ném `TypeError`; luôn `.filter(Boolean)` và thêm `AbortSignal.timeout(laneTimeoutMs)`.
- `proxyReq.end()` là bắt buộc; thiếu nó CONNECT treo vĩnh viễn. Test U11 phải đi qua fake proxy để bắt lỗi này.
- Abort controller phải destroy `proxyReq` và `tlsSocket` trong `openTunnel` (dùng `signal.addEventListener("abort", ...)` hoặc `stream.destroy` trong `finally`).
- Loser có thể resolve **sau** winner. Phải destroy socket trong một `.then` cleanup, không chỉ dựa vào abort. Test U11 assert điều này.
- Test phải assert loser socket bị destroy và chỉ có 1 POST tới upstream.

### 4.5 Classifier

```js
function classifyResponse(status, headers, bodyText) {
  if (status === 429) return "rate_limit";
  if (status === 403) {
    if (/only be used from within OpenCode|Download it at/i.test(bodyText)) {
      return "client_contract";
    }
    if (/abusive traffic/i.test(bodyText)) return "abuse_ip";
    if (/free models/i.test(bodyText)) return "free_models_unavailable";
    if (headers["cf-ray"] || /<html/i.test(bodyText)) return "cloudflare";
    return "forbidden_unknown";
  }
  if (status >= 500 && status <= 504) return "upstream_5xx";
  if (status >= 200 && status < 300) return "ok";
  return `http_${status}`;
}
```

- `headers` normalize về lowercase object, ví dụ `Object.fromEntries(new Headers(headers).entries())`.
- Đọc tối đa 8KB: `await readCapped(res, 8192)`.
- Sau khi đọc đủ 8KB, `res.destroy()` để đóng socket; body lỗi đã đủ để classify.
- Với 403/429, tạo `Response` mới từ text để executor vẫn `clone().text()` được.
- Không log body; chỉ log class, status, `x-opencode-log-id`.

### 4.6 PortPool

```js
function fisherYates(items, random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

class PortPool {
  constructor(ports, { cooldownMs = 30000, now = Date.now, random = Math.random } = {}) {
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.random = random;
    this.states = new Map(
      ports.map((port) => [port, { port, cooldownUntil: 0, failures: 0, lastUsedAt: 0 }])
    );
  }

  select(n) {
    const healthy = [...this.states.values()].filter((s) => s.cooldownUntil <= this.now());
    if (healthy.length === 0) return [];
    return fisherYates(healthy, this.random).slice(0, n).map((s) => s.port);
  }

  fail(port, cls) {
    if (cls === "client_contract" || cls === "free_models_unavailable") return; // port không có lỗi
    const state = this.states.get(port);
    if (!state) return;
    const ms = cls === "abuse_ip" || cls === "rate_limit" ? this.cooldownMs : 10000;
    state.cooldownUntil = this.now() + ms;
    state.failures++;
  }

  success(port) {
    const state = this.states.get(port);
    if (!state) return;
    state.failures = 0;
    state.cooldownUntil = 0;
    state.lastUsedAt = this.now();
  }

  clearAll() {
    for (const state of this.states.values()) {
      state.cooldownUntil = 0;
      state.failures = 0;
    }
  }

  healthyCount() {
    return [...this.states.values()].filter((s) => s.cooldownUntil <= this.now()).length;
  }
}
```

`select` trả `number[]`; `fail(port, cls)` nhận số port. Đây là contract giữa PortPool và `raceTunnels`.

Quy tắc:

- Không trả về port đang cooldown khi vẫn còn port khỏe.
- Nếu tất cả cooldown: trả `[]`, để `fetchWithTorFailover` gọi direct fallback. Không dùng lại port cooldown một cách mù quáng.
- Fisher-Yates, không `sort(() => Math.random() - 0.5)`.
- State per-process. Nếu 9router multi-worker, ghi rõ trong README và cân nhắc SQLite/local socket.

### 4.7 ControlPort Client

```js
async function newnym({ host = "127.0.0.1", port = 9051, timeoutMs = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let pending = "";
    let okCount = 0;
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      err ? reject(err) : resolve();
    };

    sock.setTimeout(timeoutMs, () => finish(new Error("ControlPort timeout")));
    sock.on("error", finish);
    sock.on("connect", () => {
      sock.write('AUTHENTICATE ""\r\nSIGNAL NEWNYM\r\nQUIT\r\n');
    });
    sock.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      let idx;
      while ((idx = pending.indexOf("\r\n")) !== -1) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 2);
        if (line === "250 OK") okCount++;
        if (line.startsWith("515")) {
          finish(new Error(`ControlPort auth failed: ${line}`));
          return;
        }
        if (line.startsWith("5")) {
          finish(new Error(`ControlPort error: ${line}`));
          return;
        }
      }
      if (okCount >= 2) finish();
    });
  });
}
```

- `AUTHENTICATE ""` chỉ hợp lệ khi `CookieAuthentication 0`; verify bằng `PROTOCOLINFO` hoặc bắt `515`.
- Nếu auth fail: disable NEWNYM trong process, log, không crash.
- Debounce 10s, coalesce concurrent calls.
- Trên success: `pool.clearAll()`, log `newnym_ok`.
- Trên fail: log `newnym_fail`, giữ cooldown.
- `sock.unref()` nếu cần, nhưng timeout 1s đã đủ.

Trigger policy:

```text
shouldNewnym(cls, pool, attempts):
  cls === "abuse_ip" and pool.healthyCount() < 2
  OR cls === "rate_limit" and attempts >= 3
```

Không gọi NEWNYM cho `client_contract`, `cloudflare`, `network`, `5xx`.

### 4.8 Adapter Patch

Trước:

```js
res = await fetchDirectSmart(new URL(targetUrl), {
  method: "POST",
  headers: outboundHeaders,
  body: transformedBody,
  signal: combinedSignal,
});
```

Sau:

```js
const _os = require("os");
const _path = require("path");

let _torRace = null;
try {
  _torRace = require(
    process.env.TOR_RACE_MODULE ||
    _path.join(_os.homedir(), ".config/9router/tor-race-core.cjs")
  );
} catch (err) {
  console.error("[tor-race] module unavailable:", err.message);
}

function fetchDirectSmart(url, opts) {
  if (!_torRace || process.env.TOR_RACE_MODE === "off") {
    return fetchDirectSmartDirect(url, opts);
  }
  return _torRace.fetchWithTorFailover(url, opts, {
    directFetch: fetchDirectSmartDirect,
  });
}
```

- Rename function gốc thành `fetchDirectSmartDirect`.
- Adapter nằm ngay trước function gốc.
- Nếu module missing, app vẫn chạy direct; không crash.
- Không hardcode username; dùng `os.homedir()`.

### 4.9 Executor Retry Changes

Plan v1 chỉ thay `fetchDirectSmart`, nhưng executor vẫn retry 15 lần. Cần sửa:

1. `BACKOFF_SCHEDULE` còn 3 entries khi `TOR_RACE_MODE !== "off"`.
2. `__tor.final` được ưu tiên trước `isRetryable`: nếu module đã exhaust lane, executor trả response luôn, không retry. Direct fallback **do adapter gọi khi `TOR_RACE_MODE=off` hoặc module missing** không có `__tor`, dùng policy cũ (cap 3). Direct fallback **bên trong module** luôn có `__tor.final=true`; nếu không, executor sẽ retry nhân bội: `3 × (3 Tor + 1 direct) = 12` request.
3. `isRetryable` cho direct fallback:
   - `client_contract`: `false` (đi vào nhánh `!isRetryable` hiện có, trả safe 429 JSON).
   - `free_models_unavailable`: `false`.
   - `abuse_ip`: `false`.
   - `429`: `true`, honor `Retry-After`.
   - `403` unknown: `false` (tránh blind retry).
4. Module gắn metadata non-enumerable:

```js
Object.defineProperty(res, "__tor", {
  value: { cls, final, port, attempts },
  enumerable: false,
});
```

5. Executor kiểm tra:

```js
if (res?.__tor?.final || res?.__tor?.cls === "client_contract") {
  return res;
}
```

- Không dùng header `x-9router-tor-*` để tránh leak ra client.
- `setOpencodeGlobalBackoff` giữ nguyên cho 429 từ direct fallback.

### 4.10 Configuration

| Env | Default | Ghi chú |
|---|---|---|
| `TOR_RACE_MODE` | `tunnel` | `off`, `tunnel`, `full` |
| `TOR_RACE_PORTS` | `9100,...,9109` | comma-separated |
| `TOR_CONTROL_PORT` | `9051` | ControlPort |
| `TOR_RACE_LANES` | `2` | tunnel race lanes |
| `TOR_LANE_TIMEOUT_MS` | `12000` | timeout CONNECT + TLS mỗi lane |
| `TOR_MAX_ATTEMPTS` | `3` | request failover attempts |
| `TOR_COOLDOWN_MS` | `30000` | abuse/rate-limit |
| `TOR_NEWNYM_DEBOUNCE_MS` | `10000` | Tor rate limit |
| `TOR_DIRECT_FALLBACK` | `1` | `0` để tắt |
| `TOR_RACE_MODULE` | `~/.config/9router/tor-race-core.cjs` | adapter path |

Không thêm config cho target URL; URL do executor truyền.

### 4.11 Logging & Metrics

JSON lines ra stderr, prefix `[tor-race]`:

```json
{"ts":"2026-10-19T12:00:00.000Z","event":"tor_request","port":9103,"class":"ok","status":200,"ms":1234,"lane":1,"mode":"tunnel","healthy":9}
{"ts":"2026-10-19T12:00:02.000Z","event":"tor_fail","port":9101,"class":"abuse_ip","status":403,"cooldownMs":30000,"healthy":8}
{"ts":"2026-10-19T12:00:03.000Z","event":"tor_newnym","ok":true,"ms":120,"cleared":3}
{"ts":"2026-10-19T12:00:04.000Z","event":"tor_fallback","reason":"pool_empty","direct":true}
```

Stats mỗi 60s:

```json
{"event":"tor_stats","requests":42,"ok":40,"clientContract":1,"abuseIp":1,"rateLimit":0,"newnymOk":1,"newnymFail":0,"p50":900,"p95":2400,"directFallback":0}
```

Không log prompt, header, API key. Chỉ log `x-opencode-log-id` nếu có.

---

## 5. Phase 0: Evidence (debug tạm thời, revert)

### 5.1 Capture 403 thật từ 9router

Mục tiêu: biết lớp 403 nào chiếm đa số và endpoint thật.

Cách làm:

1. Dùng một **debug patch** tạm thời (cùng cơ chế backup/revert của patch manager): log `status`, 300 ký tự body, `targetUrl`, `connectionId` (nếu có), `x-opencode-log-id` cho mọi response `>= 400`; phân loại sau khi thu đủ mẫu.
2. Chạy 20 request ở concurrency 4 qua 9router với agent thật.
3. Thu log, đếm class.
4. Revert debug patch.

Không log prompt/header. Nếu không muốn patch, dùng `scripts/9router-tor/probe-403.mjs` với `NINEROUTER_API_KEY` và gọi 9router API trực tiếp; script chỉ log status/body.

### 5.2 Native Proxy Experiment

Mục tiêu: test pool 10 cổng mà không viết code.

1. Backup DB:
   ```bash
   sqlite3 ~/.9router/db/data.sqlite ".backup ~/.9router/db/data.sqlite.pre-tor-v2"
   ```
2. Trong 9router UI, bật `connectionProxyEnabled=1` cho connection #01 (`9100`).
3. Tạm thời chỉ để connection #01 active; 9 connection còn lại inactive.
4. Chạy 20 request; ghi status/class.
5. Lặp với connection #02 (`9101`).
6. So sánh 9100 vs 9101 vs direct.
7. Nếu ổn, bật cả 10, giữ `outboundProxyEnabled=false`.

Verify:

```bash
sqlite3 ~/.9router/db/data.sqlite <<'SQL'
SELECT name,
       json_extract(data,'$.connectionProxyEnabled') AS enabled,
       json_extract(data,'$.providerSpecificData.connectionProxyEnabled') AS psd_enabled,
       json_extract(data,'$.connectionProxyUrl') AS url
FROM providerConnections
WHERE provider='opencode';
SQL
```

```bash
curl -s -x http://127.0.0.1:9100 https://check.torproject.org/api/ip
```

### 5.3 Baseline

Chạy 100 request ở concurrency 1/2/4:

- status counts, class counts
- p50/p95 TTFB
- prompt/completion tokens
- 429 reset format

Ghi vào `docs/plans/opencode-tor-baseline.md` (hoặc section trong plan này).

### 5.4 Decision Gate

| Kết quả Phase 0 | Quyết định |
|---|---|
| client-contract chiếm đa số | Dừng Tor workstream; mở contract workstream (xem 6.5) |
| client-contract + abuse/429 cùng có | làm contract trước; Tor chỉ cho abuse/429 sau khi client-contract = 0 |
| abuse/429 chiếm đa số + native proxy giảm lỗi | Phase 1 config; không code |
| abuse/429 chiếm đa số + native proxy không đủ | Phase 2 code |
| Tor exit bị chặn hoàn toàn | direct/other provider; không code |
| Không đủ dữ liệu | không implement; chạy lại Phase 0 |

---

## 6. Phase 1: Native Configuration

Mục tiêu: đạt G2 (10 exit, không duplicate) chỉ bằng config.

1. Bật `connectionProxyEnabled=1` cho cả 10 connection, mỗi connection trỏ `9100-9109`.
2. Giữ `outboundProxyEnabled=false` để tránh một exit cố định.
3. Giữ `rotateStrategy=round-robin`.
4. Chạy 100 request ở concurrency 1/2/4.
5. Nếu thay đổi không có hiệu lực ngay, restart 9router và verify lại.
6. So sánh với baseline Phase 0.
7. Nếu đạt acceptance: dừng, không patch code.
8. Nếu không: ghi rõ failure mode (403 class, port, latency) để Phase 2 xử lý.

Rollback Phase 1: restore DB backup, restart 9router.

Lưu ý: không sửa DB trực tiếp khi app đang chạy; dùng UI/API. Backup trước khi đổi.

Concurrency tuning là experiment riêng, không thuộc plan này: sau khi 403/429 ổn định, thử `MAX_CONCURRENT_OPENCODE=2` bằng một patch riêng, đo 100 request, quay lại 1 nếu 429 tăng.

---

## 6.5 Contract Workstream (conditional)

Chỉ mở khi Phase 0 kết luận 403 chủ yếu là client-contract, hoặc Phase 1 không cải thiện.

1. Capture một request 200 từ đường đang hoạt động (9router `usageHistory` có 648 ok) và một request 403; diff:
   - target URL từ `buildUrl()`
   - headers: `Authorization`, `User-Agent`, `x-opencode-client`, `x-opencode-session`, `x-session-affinity`, `x-session-id`, `x-opencode-project`, `Accept`, `x-request-id`
   - TLS: HTTP version, ALPN, cipher/extension nếu cần
   - Capture bằng debug log đã redact hoặc local MITM; không log `Authorization`/API key.
2. Kiểm tra `buildHeaders`/`buildUrl` của 9router có khớp contract hiện tại không; đặc biệt UA version và endpoint free tier.
3. Chạy official OpenCode client trên cùng máy (nếu có) với cùng model. Nếu 200, khác biệt là client fingerprint/attestation, không phải IP.
4. Nếu contract là header/session: sửa `buildHeaders`/`buildUrl`; test bằng một request 200, không Tor.
5. Nếu contract là TLS fingerprint/attestation: code-level Node/Tor không qua được. Chọn:
   - dùng official client làm transport,
   - local proxy do official client gọi,
   - hoặc đổi provider/model.
6. Acceptance: 200 từ cùng máy, không Tor; 0 retry client-contract.

---

## 7. Phase 2: Code Implementation (TDD)

### 7.1 Tests First (Red)

Viết test trước, chạy fail:

File: `tests/unit/opencode-tor-race.test.ts`

```text
U1  classify 200 -> ok
U2  classify 403 client_contract -> client_contract
U3  classify 403 abuse -> abuse_ip
U4  classify 429 -> rate_limit
U5  classify 403 cloudflare HTML -> cloudflare
U6  selectPorts excludes cooling
U7  cooldown 30s expiry với fake clock
U8  all cooling -> direct fallback
U9  NEWNYM debounce 10s + coalesce
U10 ControlPort 515 -> disable, không crash
U11 tunnel race: 2 port, 1 chậm; winner socket sống, loser destroyed
U12 tunnel race: chỉ 1 POST tới upstream
U13 failover: abuse 403 -> port 2 200; port 1 cooldown
U14 client_contract: 0 retry, 0 cooldown, 0 NEWNYM
U15 parent abort -> cả 2 tunnel destroyed
U16 real Response: clone/text/body stream hoạt động
U17 adapter fallback khi module missing
U18 403 body "free models" -> free_models_unavailable
U19 direct fallback sau khi hết lane -> __tor.final=true, executor không retry
U20 no parent signal -> raceTunnels không TypeError
```

### 7.2 Module

File: `scripts/9router-tor/tor-race-core.cjs`

- `// @ts-check` + JSDoc typedef cho `TorOptions`, `TorResult`.
- Built-in modules only.
- Export `fetchWithTorFailover`, `getStats`, `close`.
- Test import `.cjs` bằng `createRequire(import.meta.url)` và interface `TorRaceModule`; không dùng `any`.
- Không `any`, không TODO, không placeholder.

### 7.3 Patch Manager

Files:

- `scripts/9router-tor/apply.mjs`
- `scripts/9router-tor/revert.mjs`
- `scripts/9router-tor/verify.mjs`
- `scripts/9router-tor/base/5330.base.js`
- `scripts/9router-tor/base/opencode-base.patch`
- `scripts/9router-tor/base/manifest.json`
- `scripts/9router-tor/README.md` (runbook apply/revert/verify/restart/env/log/rollback/clean-install)

`apply.mjs`:

1. Resolve app dir: `NINEROUTER_APP_DIR` hoặc `npm root -g` + `9router/app`.
2. Verify `package.json` name là `9router`; đọc version.
3. Tìm chunk OpenCode bằng marker gốc (`prepareRequestCredentials` hoặc `buildUrl` + `"opencode"`), **không** dùng `fetchDirectSmart` vì clean install không có hàm này.
4. Check layer A markers (`fetchDirectSmart`, `compactOpenCodeContext`):
   - Nếu thiếu và `base/manifest.json` khớp version: restore base snapshot/patch, backup chunk gốc trước.
   - Nếu thiếu và version không khớp: **dừng**, in hướng dẫn tạo base patch mới. Không patch Tor lên chunk trắng.
5. Nếu marker `TOR_RACE_PATCH_V2` đã có: exit 0.
6. Backup `chunk + ".tor-race.<timestamp>.bak"`.
7. Rename function gốc, chèn adapter + marker, ghi file.
8. `node --check` chunk.
9. Copy `tor-race-core.cjs` sang `~/.config/9router/tor-race-core.cjs`.
10. In hướng dẫn restart và PID hiện tại.

`revert.mjs`: restore backup gần nhất (bao gồm base patch), `node --check`, in kết quả.  
`verify.mjs`: check base marker, Tor marker, 9router version, syntax, module hash; in summary.

Không tự động restart app. Không xóa backup cũ (giữ 3 gần nhất).

### 7.4 Executor Changes

Qua `apply.mjs`:

- `BACKOFF_SCHEDULE` còn 3 entries khi Tor mode on.
- `isRetryable` phân loại theo `res.__tor.cls`.
- `client_contract` hoặc `free_models_unavailable` -> return ngay.
- `__tor.final` -> return ngay.
- 429 -> honor `Retry-After` nếu parse được.

### 7.5 Deploy & Restart

0. Tắt `connectionProxyEnabled` cho các connection OpenCode (nếu Phase 1 đã bật) để tránh double proxy. Global `outboundProxyEnabled` giữ `false`.
1. `rtk proxy node scripts/9router-tor/apply.mjs`
2. `rtk proxy node scripts/9router-tor/verify.mjs`
3. Restart 9router bằng đúng command đang chạy (`9router -l -n --skip-update`), không `kill -9`.
4. Verify PID mới, port `20128`.
5. Smoke: 1 request, status 200, log có `tor_request` + port.

### 7.6 Rollback

1. `rtk proxy node scripts/9router-tor/revert.mjs`
2. Restart 9router.
3. Nếu Phase 1 đã đổi DB: restore `data.sqlite.pre-tor-v2`.
4. Verify direct path hoạt động.

---

## 8. Test Plan

### 8.1 Unit Tests

| ID | Case | Expected |
|---|---|---|
| U1 | `classifyResponse(200)` | `ok` |
| U2 | 403 body client-contract | `client_contract` |
| U3 | 403 body abusive | `abuse_ip` |
| U4 | 429 | `rate_limit` |
| U5 | 403 Cloudflare HTML | `cloudflare` |
| U6 | 2 port cooling, 8 healthy | chỉ trả healthy |
| U7 | cooldown 30s | hết đúng sau 30s (fake clock) |
| U8 | 10 port cooling | `select` trả `[]` |
| U9 | NEWNYM 2 lần trong 10s | lần 2 bị debounce |
| U10 | ControlPort 515 | reject, disable, không crash |
| U11 | tunnel race 2 port | winner sống, loser destroyed |
| U12 | tunnel race | upstream chỉ nhận 1 POST |
| U13 | failover abuse -> 200 | 2 POST, port 1 cooldown |
| U14 | client-contract | 1 POST, 0 retry, 0 NEWNYM |
| U15 | parent abort | cả 2 tunnel destroyed |
| U16 | 200 SSE | real Response, body stream, clone OK |
| U17 | module missing | adapter fallback direct |
| U18 | 403 body `free models` | `free_models_unavailable` |
| U19 | direct fallback sau khi hết lane | có `__tor.final=true`; executor không retry |
| U20 | no parent signal | `raceTunnels` chạy, không `TypeError` |

### 8.2 Integration Tests

File: `tests/integration/opencode-tor-race.test.ts`

- Fake CONNECT proxy: `tests/helpers/fake-connect-proxy.ts`
  - 2 port, delay khác nhau
  - đếm connection/POST
  - forward tới fake upstream
- Fake upstream: HTTPS server với fixture cert
  - trả 200 SSE, 403 client-contract, 403 abuse, 429, 500
  - đếm request body (assert không duplicate)
  - fixture cert phải có SAN `DNS:localhost` (hoặc SAN IP nếu dùng `127.0.0.1`)
- Chạy 5 request concurrent; assert:
  - không có unhandled rejection
  - không leak socket
  - stats đúng
- Mỗi test có timeout 2s; U11 phải fail nếu CONNECT không tới proxy (thiếu `proxyReq.end()`).

Fixture CA:

```bash
NODE_EXTRA_CA_CERTS=tests/fixtures/ca.pem rtk npm test -- tests/integration/opencode-tor-race.test.ts
```

### 8.3 Live Benchmark (Opt-in)

File: `scripts/bench/opencode-tor-live.mjs`

- Env: `NINEROUTER_API_KEY`, `NINEROUTER_BASE_URL` (default `http://127.0.0.1:20128`).
- 100 request, concurrency 1/2/4.
- Concurrency 4 là phía client; executor vẫn serialize upstream theo `MAX_CONCURRENT_OPENCODE=1`. Đo đúng trải nghiệm agent, không phải upstream concurrency.
- Ghi: status, class, latency, tokens.
- Không nằm trong `npm test`; không chạy trong CI.
- Dừng benchmark nếu 429 liên tục 10 request; tránh flag free tier.
- Không log prompt/API key.

### 8.4 Commands

```bash
rtk npm test -- tests/unit/opencode-tor-race.test.ts
rtk npm test -- tests/integration/opencode-tor-race.test.ts
rtk npm test
rtk npm run typecheck
rtk proxy bash scripts/verify.sh
```

### 8.5 Test Constraints

- Không gọi OpenCode thật trong unit/integration.
- Không dùng `any`, `@ts-ignore`.
- Không `.skip()` / `.only()`.
- Không hardcode API key.
- Test phải chạy offline, trừ live benchmark.

---

## 9. Acceptance Criteria

| ID | Tiêu chí | Target | Evidence |
|---|---|---|---|
| A1 | client-contract retries | 0 | log/class |
| A2 | upstream request / client request trong 200 path (tunnel) | 1.0 | fake upstream + live; failover có thể > 1.0 khi lỗi, đó là retry có chủ đích |
| A3 | abuse 403 | < 5% ở concurrency 4 | benchmark |
| A4 | 429 | < 2% ở concurrency 4 | benchmark |
| A5 | p95 TTFB | < 8s | benchmark |
| A6 | test suite | 100% pass | `rtk npm test` |
| A7 | typecheck | 0 errors | `rtk npm run typecheck` |
| A8 | patch idempotent | apply 2 lần no-op | apply script |
| A9 | rollback | restore đúng hash | revert/verify |
| A10 | no secrets in logs | grep sample | log review |
| A11 | clean-install simulation | chunk gốc + base manifest -> apply restores base + Tor, `node --check` | apply trên bản copy |

Baseline điền sau Phase 0. Nếu baseline tốt hơn target, target giữ nguyên; nếu baseline xấu hơn, target đặt theo mức cải thiện tối thiểu 50% so với baseline.

### Definition of Done

- [ ] Phase 0 evidence + baseline đã ghi.
- [ ] Native proxy experiment có kết luận.
- [ ] Unit tests đỏ trước, xanh sau.
- [ ] `rtk npm test` pass 100%.
- [ ] `rtk npm run typecheck` 0 lỗi.
- [ ] `bash scripts/verify.sh` pass.
- [ ] Apply/revert/verify chạy đúng; apply 2 lần no-op.
- [ ] 9router restart, live request 200, log có port/lane.
- [ ] Benchmark đạt target hoặc có lý do chấp nhận.
- [ ] Rollback đã test.
- [ ] Không log prompt/key; không `any`/`@ts-ignore`/TODO.
- [ ] ToS risk đã được user acknowledge.

---

## 10. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| 403 là client-contract | Tor workstream vô ích | Phase 0 gate; contract workstream |
| ToS vi phạm do xoay IP | Account/máy bị flag | ưu tiên native config, giảm load, không full hedge; user acknowledge |
| Tor exit bị chặn | 403/429 tăng | direct fallback, đo, đổi pool |
| 9router update xóa cả base + Tor patch; base patch không có trong bản gốc | mất toàn bộ tính năng | base snapshot/manifest + apply 2 lớp; verify sau update |
| ControlPort auth đổi | NEWNYM fail | bắt 515, disable, log |
| Memory leak do stream | OOM | real Response, không tee, cap error body |
| Listener leak | warning/crash | AbortSignal.any + cleanup finally |
| Multi-process state | cooldown không nhất quán | verify single process; nếu không, SQLite/local socket |
| Secret leak trong log | lộ key/prompt | không log header/body; review log |
| Tăng 429 do race | chậm hơn | tunnel race only, max 2 lane, max 3 attempt |

---

## 11. Rollout & Rollback

| Phase | Thay đổi | Gate | Rollback |
|---|---|---|---|
| 0 | debug log + native proxy experiment | class counts + baseline | revert debug, restore DB |
| 1 | bật 10 per-connection proxy | 100 request đạt target | restore DB, restart |
| 2 | module + adapter patch | tests + 20 live request | `revert.mjs`, restart |
| 3 | monitor 24h | 403/429/p95 trong target | `revert.mjs`, restart |

Monitor:

- Log `tor_stats` mỗi 60s.
- So sánh 403/429 trước/sau.
- Nếu 403 client-contract > 0 trong 10 phút: tắt Tor mode, điều tra contract.
- Nếu 429 tăng > 2x baseline: giảm `TOR_RACE_LANES` về 1, tắt full hedge.

---

## 12. Decisions & Open Questions

### 12.1 Decisions Requested

| ID | Quyết định | Recommendation | Lý do |
|---|---|---|---|
| D1 | Native proxy trước hay code trước? | Native proxy trước | rẻ, có sẵn, không tăng blast radius |
| D2 | Tunnel race hay full hedge? | Tunnel race | không duplicate POST/token |
| D3 | Client-contract xử lý thế nào? | Fail-fast + sửa contract | retry/NEWNYM vô ích |
| D4 | NEWNYM khi nào? | abuse/rate-limit + pool cạn | tránh xoay cả pool |
| D5 | Patch thế nào? | base snapshot + apply/revert/verify | 9router gốc không có `fetchDirectSmart` |
| D6 | Test thế nào? | Vitest + fake harness + live opt-in | deterministic, không đốt free tier |
| D7 | Có tăng concurrency không? | Giữ 1 trong phase này | tách biến, tránh 429 |
| D8 | Chấp nhận ToS risk? | Chỉ khi 403 không phải client-contract và native proxy không đủ | tránh lách attestation |

### 12.2 Open Questions

- Lớp 403 nào chiếm đa số?
- Native per-connection proxy có hoạt động với Tor CONNECT?
- 9router single process hay multi-worker?
- 429 reset format?
- Upstream có kiểm tra TLS fingerprint?
- 9router process có supervisor? → Có: launchd `com.hoangson.9router` + watchdog `com.hoangson.9router-watchdog` (`scripts/gateway-watchdog/`).
- Target p95/429 cụ thể là gì?
- User có chấp nhận ToS risk?

---

## 13. Implementation Tasks

| ID | Priority | Task | Files | Verify | Effort |
|---|---|---|---|---|---|
| T1 | P0 | Phase 0 capture 403 + baseline | `scripts/9router-tor/probe-403.mjs` | 20 sample, class counts | 2h |
| T2 | P0 | Native proxy experiment | DB/UI only | 20 request/port | 1h |
| T3 | P0 | Classifier + PortPool tests (red) | `tests/unit/opencode-tor-race.test.ts` | fail trước | 1h |
| T4 | P0 | ControlPort client + tests | `tor-race-core.cjs` | U9, U10 | 2h |
| T5 | P0 | Tunnel race + failover + tests | `tor-race-core.cjs`, fake proxy | U11-U15 | 4h |
| T6 | P0 | Base snapshot + patch manager | `base/*`, `apply.mjs`, `revert.mjs`, `verify.mjs` | apply 2 lần no-op + clean-install A11 | 3h |
| T7 | P1 | Executor retry/fail-fast | chunk via apply | client-contract no retry | 1h |
| T8 | P1 | Integration tests + benchmark | `tests/integration`, `scripts/bench` | 5 concurrent, 100 live | 3h |
| T9 | P1 | Deploy/restart/live verify | README/runbook | live 200 + log | 1h |
| T10 | P2 | Docs + cleanup | README, plan update | review | 1h |

TDD order: T3/T4/T5 tests trước, code sau. T6 có thể làm song song.

---

## 14. Appendix

### A. Changes From v1

| Hạng mục | v1 | v2 |
|---|---|---|
| 403 diagnosis | IP/Tor | classify; client-contract không dùng Tor |
| Race | 2 full POST | tunnel race + serial failover |
| Pool | TorPoolManager trong chunk | native per-connection proxy trước |
| NEWNYM | mỗi 403/429 | abuse/rate-limit + pool cạn |
| Response | fake object + tee | real Response |
| Test | `.cjs` live | Vitest + fake harness + live opt-in |
| Patch | hand edit | apply/revert/verify |
| Retry | không đổi 15 lần | cap 3 + fail-fast |

### B. Probe Results

```text
DIRECT   /zen/v1/chat/completions -> 403 client_contract
TOR 9100 /zen/v1/chat/completions -> 403 client_contract

9100 x3 -> 185.220.101.33
9101    -> 23.137.255.85
9102    -> 109.70.100.6
9103    -> 192.42.116.47
9100 userA -> 185.220.101.4
9100 userB -> 185.220.101.35

request({socket}) -> ECONNREFUSED (socket ignored; test với http.request)
https.request({createConnection: () => tlsSocket}) -> 200 (verified với local HTTPS fixture)
http.request CONNECT không .end() -> proxy không nhận CONNECT (treo)
AbortSignal.any([undefined, signal]) -> TypeError: signals[0] is not of type AbortSignal
5 backup gốc -> 0 fetchDirectSmart/MAX_CONCURRENT_OPENCODE/BACKOFF_SCHEDULE/compactOpenCodeContext
```

### C. DB Queries

```sql
-- proxy + connection state
SELECT name,
       json_extract(data,'$.connectionProxyEnabled') AS enabled,
       json_extract(data,'$.providerSpecificData.connectionProxyEnabled') AS psd_enabled,
       json_extract(data,'$.connectionProxyUrl') AS url
FROM providerConnections
WHERE provider='opencode';

-- global proxy
SELECT json_extract(data,'$.outboundProxyEnabled'),
       json_extract(data,'$.outboundProxyUrl')
FROM settings LIMIT 1;

-- usage
SELECT status, count(*) FROM usageHistory
WHERE provider='opencode' AND timestamp LIKE '2026-10-19%'
GROUP BY status;
```

### D. File Tree

```text
docs/plans/opencode-multilane-tor-controlport.md   # plan này
scripts/9router-tor/
  base/
    5330.base.js
    opencode-base.patch
    manifest.json
  tor-race-core.cjs
  apply.mjs
  revert.mjs
  verify.mjs
  probe-403.mjs
  README.md
scripts/bench/opencode-tor-live.mjs
tests/unit/opencode-tor-race.test.ts
tests/integration/opencode-tor-race.test.ts
tests/helpers/fake-connect-proxy.ts
tests/helpers/fake-upstream.ts
tests/fixtures/ca.pem
tests/fixtures/server.crt
tests/fixtures/server.key
```

Fixture cert là self-signed, chỉ dùng test; không phải secret production. Generate một lần bằng `openssl`, commit cùng test.

### E. References

- Plan v1: chat, 2026-10-19.
- 9router chunk: `/Users/hoangson/.local/lib/node_modules/9router/app/.next-cli-build/server/chunks/5330.js`
- 9router DB: `/Users/hoangson/.9router/db/data.sqlite`
- Tor config: `/Users/hoangson/.tor/torrc`
- Vitest config: `/Users/hoangson/Projects/vibe-studio/vitest.config.ts`
- Upstream issue (cùng message 403): https://github.com/diegosouzapw/OmniRoute/issues/15220
- Upstream contract commit: https://github.com/diegosouzapw/OmniRoute/commit/0349627c86844e87b46dc739eaa604d2cf04ed51
