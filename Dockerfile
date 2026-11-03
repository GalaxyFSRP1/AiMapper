# AiMapper + Model Studio — single container, no build step, no dependencies.
FROM node:20-alpine

WORKDIR /app
COPY . .

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    MAPPER_DATA_DIR=/data \
    MAPPER_TRUST_PROXY=1

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "app/backend/server.js"]
