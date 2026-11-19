# ScreenBackend (NestJS) — image de production.
# Construit le code TypeScript, puis une image d'exécution légère avec ffmpeg (téléchargements MP4 depuis le DVR).

# ---- Étape 1 : compilation ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
# Outils de compilation au cas où un module natif (ex. bcrypt) n'a pas de binaire précompilé pour cette plateforme.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- Étape 2 : exécution ----
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    FFMPEG_PATH=/usr/bin/ffmpeg
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Exécution sans les droits root.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tini relaie les signaux d'arrêt : le backend nettoie ses tâches (exports, sources go2rtc) avant de s'arrêter.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
