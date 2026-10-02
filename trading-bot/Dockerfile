# Bot de trading 24/7: docker build -t trading-bot . && docker run -d --restart unless-stopped \
#   -v "$PWD/config.json:/app/config.json:ro" -v "$PWD/.env:/app/.env:ro" -v "$PWD/data:/app/data" trading-bot
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm prune --omit=dev
COPY config.example.json ./
VOLUME /app/data
CMD ["node", "dist/index.js", "run"]
