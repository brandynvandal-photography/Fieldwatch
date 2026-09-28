# Fieldwatch backend. Point DB_PATH, AUDIO_DIR and RADAR_DIR at a mounted volume so alerts,
# clips and radar frames survive a redeploy.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "src/server.js"]
