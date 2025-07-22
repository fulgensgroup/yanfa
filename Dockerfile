FROM node:18-alpine

# Install FFmpeg with all the features you need
RUN apk add --no-cache \
    ffmpeg \
    imagemagick \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY package.json package-lock.json ./
# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY app.js ./

# Create required directories
RUN mkdir -p /tmp/uploads /tmp/output

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV MAX_FILE_SIZE=524288000
ENV TIMEOUT_MS=300000

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Run the application
CMD ["node", "app.js"]
