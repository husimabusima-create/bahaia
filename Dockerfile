FROM node:22-bookworm-slim

# Install FFmpeg and CA certificates inside the Debian-based container
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production and build dependencies
COPY package*.json ./
RUN npm ci

# Copy application source
COPY . .

# Build the React/Vite frontend bundle
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.ts"]
