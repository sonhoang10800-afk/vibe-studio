# OpenCode Free-Tier Baseline (Phase 0 / task T1)

> **Kết luận cuối (2026-10-21 22:35):** OpenCode free tier **không còn được dùng**. Route
> sản xuất là combo `openrouter-minimax-m3.1-flash` (→ OpenRouter
> `minimax/minimax-m3.1-flash:free`). Baseline của route đó: **200/200 request ok**
> (100 @ concurrency 4, 100 @ concurrency 8), p50 1.7–2.2s, p95 4.2–5.0s, 0 lỗi.
> Payload lớn: 100k / 500k / 1.5M ký tự đều **200**, không cần compactor/guard.
> → Plan Tor superseded; không có việc nào trong plan còn giá trị.

**Ngày:** 2026-10-21
**Máy:** macOS (darwin), 9router `0.2.1-rc.2` tại `http://127.0.0.1:20128`
**Tool:** `scripts/9router-tor/probe-403.mjs` (read-only, không ghi DB/log 9router)
**Gate:** plan v2 §5.4

---

## 1. Method

Mỗi request: `max_tokens: 8`, prompt `"ping"`, nhắm trực tiếp 9router.

- Model `oc/*` → `POST /v1/messages` (Anthropic-style). OpenCode từ chối OpenAI chat
  completions với `ModelProtocolUnsupported`.
- Model khác → `POST /v1/chat/completions`.
- Không log prompt, không log header, không log key. Body chỉ cắt 300 ký tự đầu.

Classifier (unit test: `tests/unit/opencode-probe-403.test.ts`):
`ok` · `client_contract` · `free_models_unavailable` · `cloudflare` · `abuse_ip` ·
`rate_limit` · `server_error` · `bad_request` · `unknown`

## 2. Kết quả

| Model | Concurrency | Samples | ok | rate_limit | 403 | p50 (ms) | p95 (ms) | max (ms) |
|---|---|---|---|---|---|---|---|---|
| `oc/glm-5.3-flash-free` | 1 | 60 | 33 | **27** | 0 | 1417 | 6873 | 9592 |
| `oc/glm-5.3-flash-free` | 2 | 60 | 45 | **15** | 0 | 1004 | 2230 | 3106 |
| `oc/glm-5.3-flash-free` | 4 | 100 | 64 | **36** | 0 | 2011 | 6872 | 13189 |
| `oc/deepseek-v4.1-flash-free` | 2 | 20 | **20** | 0 | 0 | 2275 | 4537 | 5778 |
| `openrouter-minimax-m3.1-flash` (combo, route DSH đang dùng) | 2 | 20 | **20** | 0 | 0 | 2141 | 10378 | 10676 |
| `oc/jev-1.13-free` | 2 | 20 | 0 | 0 | 0 | 678 | 816 | 850 |

Tổng 220 request trong 3 model: **0 lần 403** (`client_contract`, `abuse_ip`,
`cloudflare`, `free_models_unavailable` đều = 0).

## 3. Body của 429

Cả 36 mẫu giống hệt nhau:

```json
{"error":{"message":"[429]: {\"error\":{\"type\":\"server_error\",\"message\":\"Upstream request failed: Endpoint is unavailable.\"}}","type":"rate_limit_error","code":"rate_limit_exceeded"}}
```

Không có header `Retry-After`, không có `x-ratelimit-remaining`.
→ Đây **không phải** quota theo IP hay theo account. Đây là upstream OpenCode báo
endpoint của model đó đang unavailable.

## 4. Kết luận gate (plan §5.4)

| Kết quả Phase 0 | Quyết định | Đúng không |
|---|---|---|
| client_contract chiếm đa số | Dừng Tor, mở contract workstream | ❌ 0/220 |
| abuse/429 + native proxy giảm lỗi | Phase 1 config, không code | ❌ 429 là theo model, không theo IP |
| abuse/429 + native proxy không đủ | Phase 2 code (15h) | ❌ không có lỗi IP để sửa |
| Tor exit bị chặn hoàn toàn | direct/other provider, không code | ✅ **đúng** |

**Gate → dừng Tor workstream (T2–T9).** Lý do:

1. 403 không còn tái hiện. Lớp lỗi mà toàn bộ plan nhắm tới đã biến mất.
2. 429 chỉ xảy ra ở `oc/glm-5.3-flash-free`, và ở mức concurrency 1 (25–45%).
   Model khác cùng provider (`oc/deepseek-v4.1-flash-free`) là 0/20. Đây là
   capacity theo model, không phải IP.
3. Route DSH đang dùng (`openrouter-minimax-m3.1-flash` → OpenRouter free) là 0/20 429.
4. Tor hỏng sẵn, không phải lỗi code: `~/.tor/tor.log` có
   `Failed to find node for hop #1 of our path` liên tục + `32 general-purpose
   client circuits pending`; cả 10 SocksPort 9100-9109 listen nhưng không tạo
   được circuit (`curl` exit 97 = proxy handshake failure). ControlPort 9051 yêu
   cầu cookie.
5. Sửa code Tor (T2–T9 ≈ 15h) để chữa một lỗi không tồn tại, trên hạ tầng Tor
   đang chết. Tỷ lệ lợi/chi phí âm.

## 5. Việc còn đáng làm

| Ưu tiên | Việc | Lý do |
|---|---|---|
| P0 | Khôi phục `compactOpenCodeContext` (test `tests/test_opencode_compactor.cjs` đang đỏ) | Payload 6 MB → 400/429 là lỗi *thật* đã ghi nhận, độc lập Tor. Patch phải đi qua patch manager (base snapshot + apply/revert/verify) vì patch vào built chunk đã mất 1 lần |
| P1 | Nếu vẫn dùng `oc/glm-5.3-flash-free`: thêm fallback sang `oc/deepseek-v4.1-flash-free` | 0% 429 so với 25–45% |
| P2 | Sửa `~/.dsh/profiles/desktop/cordis.patch.yml`: `NINEROUTER_URL` trong `~/.zshrc` trỏ port chết 20127, instance sống ở 20128 | Đã làm trong probe (tự dò port) |

## 6. Reproduce

```bash
node scripts/9router-tor/probe-403.mjs --samples 20 --concurrency 2 \
  --model oc/glm-5.3-flash-free --out /tmp/phase0.json
```
