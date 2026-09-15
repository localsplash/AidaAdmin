# Build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
ARG BUILD_REVISION
ARG SOURCE_DATE_EPOCH
ARG BUILD_DIRTY
RUN npm run build

# Runtime stage — production dependencies only, non-root user
FROM node:22-alpine AS runtime
RUN apk add --no-cache tzdata
ENV TZ=America/Los_Angeles
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
RUN mkdir -p /app/data/assets && chown -R node:node /app/data
USER node
EXPOSE 3001
CMD ["node", "server/dist/index.js"]
