# Builds the backend from the repository root, for a host that was not pointed at backend/
# (a Railway service with no Root Directory set). backend/Dockerfile is the same image built
# from inside that folder; either one works.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY backend/ ./
EXPOSE 3000
CMD ["node", "src/server.js"]
