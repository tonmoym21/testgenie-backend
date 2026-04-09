FROM node:20-slim

WORKDIR /app

# Install Playwright OS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first (layer caching)
COPY package.json package-lock.json* ./
RUN npm install --production=false

# Install Playwright browsers
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
RUN npx playwright install chromium

# Copy source
COPY . .

EXPOSE 3000

CMD ["node", "src/index.js"]
