FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV DATABASE_URL=file:/app/data/flood_games.sqlite

WORKDIR /usr/src/app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --include=dev

COPY . .
RUN npm run build \
  && npm prune --omit=dev \
  && mkdir -p /app/data \
  && chmod 777 /app/data

CMD ["node", "dist/index.js"]
