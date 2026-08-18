# grubmaps

Anonymous foodie map. Drop pins on places you love, tag them, rate them 1–5. Inspired by hoodmaps.com. Currently seeded on Milwaukee, WI.

## Stack

- **Web**: Vue 3 + Vite + MapLibre GL (OpenStreetMap raster tiles, no API key)
- **API**: Bun + Hono + `bun:sqlite`
- **Storage**: local `server/grubmaps.db` (SQLite)

## Run locally

Requires [Bun](https://bun.sh) 1.x.

```sh
bun install --cwd web
bun install --cwd server
bun run dev
```

Web: http://localhost:5173  ·  API: http://localhost:3001

Vite proxies `/api/*` → `http://localhost:3001`.

## API

- `GET  /api/pins` — latest 5000 pins
- `POST /api/pins` — `{ lat, lng, tag, rating }` (rating: integer 1–5, tag ≤ 80 chars)
  - Rate limit: 10 pins per IP per hour (naive in-memory)

## Layout

```
server/   Hono + SQLite API
web/      Vue 3 + Vite + MapLibre
scripts/  dev-server orchestrator
```

## Later

- Ship the web app to production (Fly.io or similar)
- Native SwiftUI iOS + macOS client hitting the same `/api/pins` endpoints
