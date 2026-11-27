# Image chung cho api, worker, db-bootstrap (ADR-002: cùng image, khác lệnh). Build context = gốc repo.
FROM node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/money_weight/ts/package.json packages/money_weight/ts/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @fruit/api...
COPY packages/money_weight/ts packages/money_weight/ts
COPY apps/api apps/api
RUN pnpm --filter @fruit/money_weight run build && pnpm --filter @fruit/api run build
RUN pnpm --filter @fruit/api deploy --prod --legacy /out

FROM node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS runtime
ENV NODE_ENV=production TZ=Asia/Ho_Chi_Minh
RUN apk add --no-cache tzdata wget
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./dist
COPY infra/sql ./infra/sql
COPY apps/api/prisma/migrations ./prisma/migrations
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
