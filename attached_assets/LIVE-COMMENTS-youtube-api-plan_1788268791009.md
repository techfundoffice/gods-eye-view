# LIVE COMMENTS from YouTube API (current active broadcast)

OBS only pushes video. YouTube is the source of truth for the live broadcast and its chat. The homepage must **not** bind comments to the OBS/encoder session or to a saved `.env` broadcast id.

Correct association:

> YouTube Data API → current active broadcast (`mine=true`) → `snippet.liveChatId` → `liveChatMessages.list`

not:

> encoder / `YOUTUBE_BROADCAST_ID` → InnerTube poll of that id

Official refs: [LiveBroadcasts: list](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/list), [snippet.liveChatId](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts), [LiveChatMessages: list](https://developers.google.com/youtube/v3/live/docs/liveChatMessages/list).

## Why the list is empty now

`GET /api/youtube/homepage-chat/feed` is mounted, but `sessionStatus` in `vite.config.js` still does this:

- take `YOUTUBE_BROADCAST_ID` / watch URL (`CVSB4QJhVTU`)
- if encoder is not `live`, force `public-live-unverified`
- InnerTube poll of that id

YouTube returns **ended**. Feed: `active: true`, `items: []`, `error.kind: ended`. The client never calls `publishViewerMessage`. Broadcast CSS hides `#gev-nextchat-status`, so the HUD looks empty instead of showing `YT chat unavailable · This live broadcast has ended.`

The channel **is** live on a different video (`9ZiwwXr-qU4` / “Techfundoffice Live Stream”).

ADMIN already has the official path: `src/youtubeCommentHarness.js` `fetchOfficialLiveChat` and `src/youtubeLive.js` call `liveBroadcasts` + `liveChatMessages`. Homepage chat does not use it.

## Implementation (Replit workspace)

### 1. Discover the current YouTube live chat (server)

Add a small helper (prefer `src/youtubeBroadcast.js`, next to `listCompatibleBroadcasts` / `summarizeBroadcastItem`):

```http
GET liveBroadcasts?part=id,snippet,status,contentDetails
  &broadcastStatus=active
  &mine=true
```

Pick the item with `status.lifeCycleStatus === 'live'` (else first `liveStarting` with a chat id). Return `{ videoId, title, watchUrl, liveChatId }` from `id` + `snippet.liveChatId`. Extend `summarizeBroadcastItem` to include `liveChatId`. If none: `{ active: false }`, do not keep the old id.

Use the **channel-owner OAuth** already in `youtubeProxy()`: `oauth.findWritableAuthorization()` + `createYoutubeApiCaller(oauth.proxy, authorization)`. Homepage viewers never see tokens.

Cache the discovered `{ videoId, liveChatId }` briefly (e.g. 15–30s). **Invalidate immediately** when `liveChatMessages` reports ended / 404 / `forbidden` / chat disabled, then rediscover on the next poll. Do not fall back to `process.env.YOUTUBE_BROADCAST_ID`.

### 2. Homepage feed reads `liveChatMessages`

Change `src/youtubeHomepageChatServer.js` so `/feed` does **not** take identity from encoder `sessionStatus()`:

1. Discover as above (or use cache).
2. If no active broadcast or no OAuth: HTTP 200 `{ active: false, status: 'offline'|'unauthenticated', items: [], error? }`.
3. Else `GET liveChatMessages?liveChatId=…&part=snippet,authorDetails` (reuse harness `fetchOfficialLiveChat` / `normalizeLiveChatMessage` if that keeps one normalizer).
4. Map to the existing public shape `{ id, author, text, publishedAt, source: 'youtube', actions }` so `youtubeHomepageInteraction.js` is unchanged.
5. Honor YouTube `pollingIntervalMillis`.
6. On ended: `active: false`, `error.kind: 'ended'`, clear cache. Never keep polling `CVSB4QJhVTU`.

`streamList` is optional later; `list` is enough.

Wire in `vite.config.js` `youtubeProxy()`:

```js
createYoutubeHomepageChatMiddleware({
  discoverActive: () => discoverActiveYoutubeLive({ call: ... }),
  chat: officialLiveChatReader,
})
```

**Remove** the `envBroadcastId` / `public-live-unverified` `sessionStatus` that treats any saved id as live. Encoder `liveMiddleware` sessionStatus stays as it was (watchUrl fill only when encoder is actually starting/encoding/live). OBS ingest and comment ingestion stay independent.

Keep `/api/youtube/homepage-chat` mounted **before** the OAuth catch-all `/api/youtube`.

### 3. Show chat errors; keep polling

In `style.css` broadcast overlay: stop `display: none` on `#gev-nextchat-status`. Header/composer can stay hidden. Status must remain visible for `YT LIVE · …` and `YT chat unavailable · …`.

Do not stop `youtubeHomepageInteraction` polling in Clean View / cockpit / recording / scene-playback. Those CSS rules may hide the overlay; they must not hide the fetch loop (it already runs at init). No change to Mission Control transparency.

### 4. Tests

- `src/youtubeHomepageChat.test.mjs`: feed uses `broadcastStatus=active` discovery, not a stub session id; ended chat → `active: false` + error, next call rediscovers; no active broadcast → empty, not a stale id; public payload still has only author/text (no tokens).
- `src/youtubeProductionWiring.test.mjs`: keep the unauthenticated `/feed` mount test (must not be the OAuth “Sign in to YouTube” body). Stub discover/chat so unit tests do not hit Google.
- Revert/avoid asserting encoder session status as the comment source.

### 5. Verify on the live Replit

Restart Vite if config changed.

```bash
curl -sS http://127.0.0.1:5000/api/youtube/homepage-chat/feed
```

Expect `active: true`, current live `videoId` (not `CVSB4QJhVTU`), `items` with recent chat (`cloudcomputerai: testing testing 123` only if still in the YouTube window). Hard-refresh the globe: LIVE COMMENTS shows `author: text`. If YouTube is down/ended, the red lane shows the error string, not a silent empty HUD.

## Out of scope

- Changing OBS/ffmpeg ingest or ODBC audit.
- Writing back to YouTube (replies, bans).
- InnerTube as the homepage source (ADMIN harness may keep it as fallback).
- Making ordinary chat move the globe.
- Renaming the satellite HUD `ORB` / `PASS` readout.
