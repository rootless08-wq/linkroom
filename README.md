# LinkRoom

A free-first one-to-one video chat MVP by Jayant Adhikary. Meet someone at random, or create a private room and share an invitation.

## Features

- Start Chat, a shared random matchmaking queue, Next, and Stop
- WebSocket signaling, with HTTP fallback when a proxy blocks upgrades
- Peer-to-peer WebRTC video, audio, and text chat
- Mute, Camera Off, and Switch Camera without ending the call
- Laptop-friendly call layout, small self-preview, and responsive mobile controls
- Reports stored for review and server-enforced guest blocking
- Secure private invitations with a 24-hour joining window, two-person admission, and refresh recovery
- Shared reactions and Original, Warm, Cool, Mono, and Soft video filters
- Side chat with opt-in photos, videos, audio, GIFs, and files (up to 20 MB each)

## Free-first architecture

React and TypeScript run on Vinext. A Cloudflare Worker handles WebSockets and uses the existing D1 database to coordinate matches across Worker instances. Media and text use WebRTC directly between browsers. No paid SDK, account service, payment provider, or media relay is required for the MVP.

This is a small-trial implementation, not a promise of unlimited free traffic. D1 coordination polls every 1.5 seconds while a connection is open and consumes database reads and writes. Check the current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) before growing traffic. No paid plan or billing upgrade is enabled by this source.

## Local setup

Use Node.js 24 (22.18+ also supports the TypeScript tests) and pnpm 11.25.0.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Apply the SQL files in `drizzle/` in filename order to the local D1 database using Wrangler before testing calls. Use localhost or HTTPS for camera access. Two separate browser profiles or devices are needed for random matchmaking: guest cookies are shared between tabs in one profile.

```sh
pnpm exec tsc --noEmit
node --test tests/*.test.mjs
pnpm build
```

The camera tests use simulated devices. Test with two real devices to verify camera permissions, audio, network traversal, and physical front/back camera switching.

## Cloudflare deployment

The existing `linkroom` Worker is connected to this repository's `main` branch through Cloudflare Workers Builds. Its build uses Node.js 24, sets `CLOUDFLARE_D1_DATABASE_ID` to the existing database ID, and runs `pnpm run build`. The deploy command is `pnpm exec wrangler deploy --config dist/server/wrangler.json --name linkroom`. Preview builds are disabled. Deployment credentials are held by Cloudflare.

The random-chat migration `0002_nice_champions.sql` was applied to the existing production D1 database on 2026-09-24. Existing private-room tables were retained. Apply future migrations before deploying code that requires them.

For the standalone GitHub project, copy `wrangler.example.jsonc` to the ignored `wrangler.jsonc`, insert your existing D1 database ID, and authenticate Wrangler. Keep the Worker name `linkroom` to update the existing URL. Apply only unapplied migrations in `drizzle/`, then build and deploy. Do not recreate the database or run old migrations again.

Migration `0003_secure_private_rooms.sql` was applied to the existing production database on 2026-09-26. It adds separate secure-room tables and retains earlier tables. Apply it once to other environments before deploying this update. Do not commit credentials, local runtime caches, or environment secrets to GitHub.

## Behavior and boundaries

- Atomic database batches claim a waiting partner. Room membership is checked when relaying offers, answers, and ICE candidates.
- Next returns both people to matchmaking and avoids immediately pairing them again. Stop releases local media and leaves the queue. Disconnected peers expire after 45 seconds.
- Text is sent over a WebRTC data channel and cleared when the conversation changes. LinkRoom does not record audio or video. Peers can still record their own screens and learn connection information.
- A random guest is identified by a secure HTTP-only cookie; the database stores its hash. Blocks work while that browser retains its identity. Clearing cookies or using another browser can evade guest blocking. This is not an account-level ban.
- Reports store the reason, guest identifiers, room identifier, and timestamp, with `pending` status. Review `chat_reports` through authenticated D1 administration. There is no public moderation API, live moderation team, or automatic enforcement beyond blocking the reported guest for the reporter.
- Temporary random-chat signaling is pruned after ten minutes and inactive guest rows after one day when sessions initialize. Reports and blocks remain until an operator reviews or removes them. Browser text history is not saved.
- STUN is configured; TURN is not. Restrictive networks may fail to connect. No 100,000-users/day capacity claim is made.
- Private room keys use random 256-bit invitation capabilities in URL fragments. Each member has a separate credential, hashed at rest and checked on every signaling request. Invitations expire after 24 hours; authenticated activity renews the room session. Older six-character invitations must be recreated.
- Attachments need receiver acceptance before transfer. Transfers have backpressure, cancellation, timeouts, size limits and a 40 MB retained-download budget. HTML/SVG are download-only. This is not malware scanning. History and temporary download URLs are cleared on leaving or changing partners.
- Original video bypasses effect processing until an effect is selected. Requested capture is up to 720p at 30 fps; actual quality depends on device and network. The browser adapts bitrate. Filters process locally; reactions are shared over the data channel. These are browser effects, not Apple FaceTime or face tracking.

## Upgrade path

`lib/chat-server.ts` contains the matchmaking and storage adapter, `worker.ts` handles transport, and `lib/random-client.ts` owns the browser call lifecycle.

1. Replace frequent D1 coordination with a WebSocket coordinator using Durable Objects or a Node.js service plus Redis.
2. Add coturn or a managed TURN service with short-lived server-issued credentials. Avoid permanent TURN passwords in client code.
3. Add authenticated accounts, stronger rate limits and abuse controls, a moderator workflow, and retention policies before broader promotion.
4. Add payments and ads only after account and moderation foundations are ready. Select providers for the business jurisdiction at that time.
5. Load-test concurrency and track actual relay bandwidth and database usage before increasing hosting capacity.

## Browser integration check

Run `node tests/preview-server.mjs` and open `http://127.0.0.1:3001/__test`. This local-only harness uses in-memory SQLite, generated video/silent audio, and two real browser peer connections. It tests connection, text, reactions, consented file transfer, filters, toggles and refresh recovery without accessing physical media devices. The harness is not a production route.
