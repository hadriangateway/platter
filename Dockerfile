FROM oven/bun:latest AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src/ src/
COPY tsconfig.json ./
RUN bun build src/index.ts --compile --external x11 --outfile=platter

FROM debian:bookworm-slim
LABEL io.modelcontextprotocol.server.name="io.github.hadriangateway/platter"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ripgrep ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/platter /usr/local/bin/platter
WORKDIR /work
EXPOSE 3100
ENTRYPOINT ["platter"]
