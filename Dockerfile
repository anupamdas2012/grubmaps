# Grubmaps / Crave backend — Bun + Hono + SQLite.
# Frontend deploys separately to GitHub Pages (see .github/workflows/deploy-pages.yml).
# This container serves only /api/*; CORS is open so the GH Pages origin
# can hit it directly.
#
# SQLite lives on a persistent Fly.io volume mounted at /data.
# Env vars set by fly.toml:
#   DB_PATH=/data/grubmaps-review.db
#   PORT=3001
# Set OPENAI_API_KEY via `fly secrets set OPENAI_API_KEY=sk-...`.

FROM oven/bun:1 AS deps
WORKDIR /app
COPY server/package.json ./server/
RUN cd server && bun install

FROM oven/bun:1
WORKDIR /app
COPY --from=deps /app /app
COPY server ./server
COPY tools ./tools
COPY package.json ./
# Copy the LLM style reference so tools/make-icon.ts works if invoked
# via `fly ssh console -C 'bun run icon ...'`. Not needed at runtime.
COPY .context/style-refs ./.context/style-refs

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

CMD ["bun", "run", "server/index.ts"]
