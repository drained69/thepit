# The Pit gate agent — the image the TEE runs. Its digest becomes part of the
# measurements the agent contract approves, so pin everything.
FROM node:22-alpine@sha256:92d51e5f20b7ff58faa5a969af1a1cec6cbec3fbff7e0f523242b9b5c85ad887
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
EXPOSE 3000
CMD ["node", "src/server.mjs"]
