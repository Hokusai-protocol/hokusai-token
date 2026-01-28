# Build stage
FROM node:18-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci --only=production && \
    cp -R node_modules prod_node_modules

# Copy source code and pre-built files
COPY src ./src
COPY dist ./dist
COPY contracts ./contracts
COPY deployments ./deployments


# Skip build for now - using pre-built dist
# RUN npm run build

# Runtime stage
FROM node:18-alpine

# Install dumb-init for proper signal handling and curl for health checks
RUN apk add --no-cache dumb-init curl

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy production dependencies
COPY --from=builder --chown=nodejs:nodejs /app/prod_node_modules ./node_modules

# Copy built application
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist

# Copy contracts
COPY --from=builder --chown=nodejs:nodejs /app/contracts ./contracts

# Copy deployments
COPY --from=builder --chown=nodejs:nodejs /app/deployments ./deployments

# Copy package.json for reference
COPY --chown=nodejs:nodejs package*.json ./

# Switch to non-root user
USER nodejs

# Expose ports
EXPOSE 8002 9091

# Health check (uses PORT environment variable, defaulting to 8002)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const port = process.env.PORT || 8002; require('http').get(\`http://localhost:\${port}/health\`, (res) => process.exit(res.statusCode === 200 ? 0 : 1))"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application (API server by default)
# Use dist/monitoring-server.js for monitoring service
CMD ["node", "dist/server.js"]