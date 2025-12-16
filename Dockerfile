# Use official Node image
FROM node:20-alpine

WORKDIR /app

# Install build deps (if any native modules)
RUN apk add --no-cache tini

COPY package.json package-lock.json* ./
RUN npm ci --only=production

COPY . .

ENV NODE_ENV=production

# Run as non-root user (optional)
# RUN addgroup -S app && adduser -S app -G app
# USER app

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]