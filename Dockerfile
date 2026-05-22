FROM oven/bun:1.1-alpine AS base
WORKDIR /app

# Install docker CLI so container can check docker daemon if needed
RUN apk add --no-cache docker-cli

# Copy package files
COPY package.json bun.lock ./

# Install production dependencies
RUN bun install --frozen-lockfile --production

# Copy source code
COPY src ./src
COPY tsconfig.json ./

# Make data directory
RUN mkdir -p /app/data

# Run as non-root user (optional, but keep default for docker socket write access)
EXPOSE 3000
