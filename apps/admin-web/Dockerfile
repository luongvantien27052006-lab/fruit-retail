# admin-web (Next.js standalone). Build context = gốc repo.
FROM node:24.22.3-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/admin-web/package.json apps/admin-web/
RUN pnpm install --frozen-lockfile --filter @fruit/admin-web...
COPY apps/admin-web apps/admin-web
RUN pnpm --filter @fruit/admin-web run build

FROM node:24.22.3-alpine AS runtime
ENV NODE_ENV=production PORT=3001 HOSTNAME=0.0.0.0 TZ=Asia/Ho_Chi_Minh
WORKDIR /app
COPY --from=build /repo/apps/admin-web/.next/standalone ./
COPY --from=build /repo/apps/admin-web/.next/static ./apps/admin-web/.next/static
USER node
EXPOSE 3001
CMD ["node", "apps/admin-web/server.js"]
