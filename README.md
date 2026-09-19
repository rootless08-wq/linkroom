# LinkRoom

LinkRoom is a lightweight private video-chat application. Create a room, share one link or a six-character code, and start a peer-to-peer call without creating an account.

**Live demo:** [linkroom.linkroom-app.workers.dev](https://linkroom.linkroom-app.workers.dev/)

## Highlights

- Private room links and short join codes
- Browser-based peer-to-peer audio and video with WebRTC
- Microphone and camera controls
- Responsive interface for desktop and mobile
- Two-hour room expiration
- Cloudflare D1 signaling storage with automatic cleanup
- No account required and no call recording

## Technology

- React 19 and TypeScript
- Vinext and Vite
- WebRTC for peer-to-peer media
- Cloudflare Workers and D1
- Tailwind CSS and Radix UI

## Run locally

Requirements: Node.js 22.13 or newer and pnpm 11.

```bash
pnpm install
pnpm dev
```

Open the local address printed in the terminal. Camera and microphone access require HTTPS or a localhost address.

## Deploy to Cloudflare

1. Create a D1 database named `linkroom-db`.
2. Copy `wrangler.example.jsonc` to `wrangler.jsonc`.
3. Replace `YOUR_D1_DATABASE_ID` with the database ID from Cloudflare.
4. Apply both SQL files in `drizzle/` to the remote database in filename order.
5. Run `pnpm deploy`.

The Worker expects a D1 binding named `DB`.

## How it works

LinkRoom stores temporary WebRTC signaling messages in D1 while two browsers establish a direct media connection. Room and signaling records expire after two hours. Audio and video are not stored by the application.

## Current scope

LinkRoom supports one-to-one calls. It uses a public STUN server and does not currently include a TURN relay, so calls may fail on restrictive corporate or carrier networks.

## Author

Created by **Jayant Adhikary** as a networking-focused software project.
