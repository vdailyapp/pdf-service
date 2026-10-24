# pdf-service: Bun + Debian Chromium + fonts with Vietnamese coverage (add fonts-noto-cjk for CJK, ~+300 MB).
FROM oven/bun:1.4.3-debian

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       chromium fonts-noto-core fonts-noto-color-emoji fonts-dejavu-core fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
# Sample templates; mount your own over /app/templates.
COPY examples/invoice ./templates/invoice
COPY examples/report ./templates/report

ENV NODE_ENV=production \
    PORT=3000 \
    TEMPLATES_DIR=/app/templates \
    CHROME_PATH=/usr/bin/chromium \
    CHROME_NO_SANDBOX=1

USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.PORT ?? 3000) + (process.env.API_PREFIX ?? '/api/v1/pdf') + '/health/ready'); process.exit(r.ok ? 0 : 1)"
CMD ["bun", "src/server.ts"]
