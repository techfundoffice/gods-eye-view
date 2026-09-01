# #27 Follow Current YouTube Broadcast

Repair the public LIVE COMMENTS feed on the Replit God’s Eye View app (`ssh replit-gods-eye-view`). YouTube is the source of truth for broadcast and chat identity. OBS/FFmpeg ingest and the homepage command runner stay separate.

## Binding (must)

```
YouTube Data API
  → liveBroadcasts.list?broadcastStatus=active&mine=true
  → verified live item
  → snippet.liveChatId
  → liveChatMessages.list
```

Never treat `YOUTUBE_BROADCAST_ID`, `YOUTUBE_WATCH_URL`, or encoder `sessionStatus()` as proof a broadcast is still live.

## Current break

`vite.config.js` `sessionStatus` fills identity from env `CVSB4QJhVTU` and forces `public-live-unverified` when the encoder is not live. Homepage InnerTube then polls that ended id. Feed: empty items, `error.kind: ended`. Broadcast CSS hides `#gev-nextchat-status`, so the HUD looks empty. The channel’s real live video is a different id (`9ZiwwXr-qU4`).

ADMIN already calls official `liveBroadcasts` + `liveChatMessages` (`src/youtubeCommentHarness.js`, `src/youtubeLive.js`). Homepage does not.

## Implementation

Work in `/home/runner/workspace` on Replit.

### 1. Server-side active-broadcast discovery — `src/youtubeBroadcast.js`

- Extend `summarizeBroadcastItem` with `liveChatId` from `snippet.liveChatId`.
- Add `listActiveBroadcasts(call)` → `liveBroadcasts.list` with `part=id,snippet,status,contentDetails`, `broadcastStatus=active`, `mine=true`.
- Add `discoverActiveYoutubeLive(call)`:
  - Prefer `status.lifeCycleStatus === 'live'` with a `liveChatId`.
  - `liveStarting` (or live without chat id) → connecting, not verified-live.
  - None → `{ active: false }`. Never keep the previous id.
  - Return a **redacted** identity only: `{ videoId, title, watchUrl, liveChatId, lifeCycleStatus }`. No stream keys.
- Short in-memory cache (15–30s). **Invalidate immediately** on ended / not-found / forbidden / chat-disabled. **No env broadcast id fallback.**
- Tests in `src/youtubeBroadcast.test.mjs`.

### 2. Replace homepage session binding — `src/youtubeHomepageChatServer.js` + `vite.config.js`

- `/feed` identity comes from `discoverActiveYoutubeLive`, not encoder `sessionStatus()`.
- Inject OAuth in `youtubeProxy()`: `oauth.findWritableAuthorization()` + `createYoutubeApiCaller(oauth.proxy, authorization)`. Public HTTP stays unauthenticated; tokens stay server-side.
- **Remove** `envBroadcastId` / `public-live-unverified` `sessionStatus` used by homepage chat. Encoder `liveMiddleware` sessionStatus stays: watchUrl fill only when encoder is actually starting/encoding/ingesting/waiting-for-youtube/live.
- Keep `middlewares.use('/api/youtube/homepage-chat', …)` **before** `/api/youtube`.

### 3. Read and recover live chat

- `liveChatMessages.list?liveChatId=…&part=snippet,authorDetails` (reuse harness `fetchOfficialLiveChat` / `normalizeLiveChatMessage` if that keeps one normalizer).
- Map to existing public shape `{ id, author, text, publishedAt, source, actions }` so `youtubeHomepageInteraction.js` ingest, duplicate suppression, cooldowns, and validated navigation stay unchanged.
- Honor YouTube `pollingIntervalMillis` and continuation / nextPageToken.
- On ended/missing/forbidden/disabled: clear cache, return truthful error, rediscover next request. Never retry `CVSB4QJhVTU`.
- `streamList` not required.

### 4. Truthful public states

| Condition | `active` | `status` | `commandsEnabled` |
|---|---|---|---|
| Owner OAuth missing | false | `unauthenticated` | false |
| No active broadcast | false | `offline` | false |
| `liveStarting` / chat id not ready | false | `connecting` | false |
| Verified `lifeCycleStatus=live` + liveChatId | true | `live` | true |
| Chat/broadcast ended, 404, forbidden, disabled | false | `unavailable` or `ended` | false |

Viewer command execution (existing executor lease/generation) stays disabled unless verified live. Homepage action runner eligibility unchanged.

### 5. Keep status visible — `style.css`

Stop `display: none` on `#gev-nextchat-status` in the broadcast overlay. Header/composer may stay hidden. Polling in `youtubeHomepageInteraction.js` must not depend on overlay visibility (Clean View / cockpit / recording / scene-playback). No Mission Control / first-run GUI changes.

### 6. Tests

- `src/youtubeHomepageChat.test.mjs`: injected discovery/chat fakes; verified-live feed shape; connecting vs live; ended → cache clear → rediscovery (no stale id); no-auth/offline 200 + empty items; redaction (no tokens/keys/raw HTML).
- `src/youtubeBroadcast.test.mjs`: active list, liveChatId on summary, selection of verified live.
- `src/youtubeProductionWiring.test.mjs`: unauthenticated `/feed` is not the OAuth “Sign in to YouTube” body.
- Keep ticker, viewer-navigation, and cooldown tests in `src/youtubeHomepageChat.test.mjs`.

### 7. Verify the running app

Restart the Replit “Start application” workflow (`HOST=0.0.0.0 PORT=5000 npm run dev`).

```bash
curl -sS http://127.0.0.1:5000/api/youtube/homepage-chat/feed
```

Expect `active: true`, current live `videoId` (not `CVSB4QJhVTU`), normalized `items`. Hard-refresh the globe: LIVE COMMENTS shows `author: text`. If no verified broadcast, visible status/error, not a silent empty HUD.

## Out of scope

- Chromium capture, FFmpeg, RTMP, stream keys, encoder state machine.
- Creating/selecting/binding/transitioning/ending broadcasts from homepage polling.
- Changing which viewer messages become camera actions.
- YouTube writes (replies, bans, likes).
- Mandatory `streamList`.
- InnerTube as homepage primary (ADMIN may keep it).
- Persisting comments or discovered identities.

## Primary files

`src/youtubeBroadcast.js`, `src/youtubeBroadcast.test.mjs`, `src/youtubeHomepageChatServer.js`, `src/youtubeHomepageChat.test.mjs`, `src/youtubeHomepageInteraction.js`, `src/youtubeCommentHarness.js`, `src/youtubeProductionWiring.test.mjs`, `vite.config.js`, `style.css`.
