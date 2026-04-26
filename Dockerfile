FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

COPY package.json ./

# Fetch the correct pnpm version without installing deps
# This reads the "packageManager" field and downloads that pnpm version
RUN corepack prepare --activate $(node -p "require('./package.json').packageManager")
RUN pnpm --version

FROM base AS prod-deps
COPY package.json pnpm-*.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

FROM base AS build
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY . .

# Install all dependencies (including dev) for building the project
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm run build

FROM base
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
ENV NODE_ENV="production"
CMD ["pnpm", "start"]
