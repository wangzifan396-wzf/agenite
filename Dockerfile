# Agenite — local-first AI agent. Ships zero runtime dependencies.
FROM node:20-alpine
WORKDIR /app

# No npm install: the project is dependency-free, so we just copy the source.
COPY package.json server.js build.js ./
COPY src ./src
COPY dist ./dist

ENV HOST=0.0.0.0
ENV PORT=4173
EXPOSE 4173

# Persist agent memory, traces and config here.
VOLUME ["/root/.agenite"]

CMD ["node", "server.js"]
