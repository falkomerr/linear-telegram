FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile
COPY . ./
RUN bun run build
CMD ["bun", "run", "dist/index.js"]
