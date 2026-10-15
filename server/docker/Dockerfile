# Node 24 — required for the built-in `node:sqlite` module (no native build).
FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Install JS deps first for better layer caching.
COPY package*.json ./
RUN npm install --omit=dev

# Install Chromium + matching OS libraries for the Playwright login.
RUN npx playwright install --with-deps chromium

# App source (see .dockerignore — secrets, state and downloads are NOT baked in).
COPY . .

# Session + SQLite state, and the downloaded files.
ENV DATA_DIR=/app/data
ENV DOWNLOAD_DIR=/app/downloads
RUN mkdir -p /app/data /app/downloads
VOLUME ["/app/data", "/app/downloads"]

EXPOSE 3100
CMD ["node", "index.js"]
