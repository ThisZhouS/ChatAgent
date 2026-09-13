FROM node:22-alpine

RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787

CMD ["node", "apps/server/dist/index.js"]
