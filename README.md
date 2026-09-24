# LinkRoom

A free-first one-to-one video chat MVP by Jayant Adhikary. Meet someone at random, or create a private room and share an invitation.

## Features

- Start Chat, a shared random matchmaking queue, Next, and Stop
- WebSocket signaling, with HTTP fallback when a proxy blocks upgrades
- Peer-to-peer WebRTC video, audio, and text chat
- Mute, Camera Off, and Switch Camera without ending the call
- Laptop-friendly call layout, small self-preview, and responsive mobile controls
- Reports stored for review and server-enforced guest blocking
- Existing private rooms, invitation links, and six-character codes

## Free-first architecture

React and TypeScript run on Vinext. A Cloudflare Worker handles WebSockets and uses the existing D1 database to coordinate matches across Worker instances. Media and text use WebRTC directly between browsers. No paid SDK, account service, payment provider, or media relay is required for the MVP.

This is a small-trial implementation, not a promise of unlimited free traffic. D1 coordination polls every 1.5 seconds while a connection is open and consumes database reads and writes. Check the current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) before growing traffic. No paid plan or billing upgrade is enabled by this source.

## Local setup

Use Node.js 24 (22.18+ also supports the TypeScript tests) and pnpm 11.25.0.

```sh
pnpm install --frozen-lockfile
pnpm exec drizzle-kit generate
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

For the standalone GitHub project, copy `wrangler.example.jsonc` to the ignored `wrangler.jsonc`, insert your existing D1 database ID, and authenticate Wrangler. Keep the Worker name `linkroom` to update the existing URL. Apply only unapplied migrations in `drizzle/`, then build and deploy. Do not recreate the database or run old migrations again.

For the managed Sites project, `.openai/hosting.json` declares the existing DB binding; the Sites deployment workflow applies migrations and publishes the Worker. Do not commit credentials, local runtime caches, or environment secrets to GitHub.

## Behavior and boundaries

- Atomic database batches claim a waiting partner. Room membership is checked when relaying offers, answers, and ICE candidates.
- Next returns both people to matchmaking and avoids immediately pairing them again. Stop releases local media and leaves the queue. Disconnected peers expire after 45 seconds.
- Text is sent over a WebRTC data channel and cleared when the conversation changes. LinkRoom does not record audio or video. Peers can still record their own screens and learn connection information.
- A random guest is identified by a secure HTTP-only cookie; the database stores its hash. Blocks work while that browser retains its identity. Clearing cookies or using another browser can evade guest blocking. This is not an account-level ban.
- Reports store the reason, guest identifiers, room identifier, and timestamp, with `pending` status. Review `chat_reports` through authenticated D1 administration. There is no public moderation API, live moderation team, or automatic enforcement beyond blocking the reported guest for the reporter.
- Temporary random-chat signaling is pruned after ten minutes and inactive guest rows after one day when sessions initialize. Reports and blocks remain until an operator reviews or removes them. Browser text history is not saved.
- STUN is configured; TURN is not. Restrictive networks may fail to connect. No 100,000-users/day capacity claim is made.
- Private invitation rooms retain their earlier code-based signaling implementation. Treat the invite link as a secret.

## Upgrade path

`lib/chat-server.ts` contains the matchmaking and storage adapter, `worker.ts` handles transport, and `lib/random-client.ts` owns the browser call lifecycle.

1. Replace frequent D1 coordination with a WebSocket coordinator using Durable Objects or a Node.js service plus Redis.
2. Add coturn or a managed TURN service with short-lived server-issued credentials. Avoid permanent TURN passwords in client code.
3. Add authenticated accounts, stronger rate limits and abuse controls, a moderator workflow, and retention policies before broader promotion.
4. Add payments and ads only after account and moderation foundations are ready. Select providers for the business jurisdiction at that time.
5. Load-test concurrency and track actual relay bandwidth and database usage before increasing hosting capacity.
