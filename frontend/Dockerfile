# --- Builder ---
FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# CRA bakes REACT_APP_* vars into the static JS bundle AT BUILD TIME, not
# read at container startup — so these have to be build args, not just
# environment variables on the runtime container. Override with
# --build-arg when the API isn't on localhost:5000 (see docker-compose.yml
# and the README's Deployment section for the Vercel/Netlify case, where
# you set these in the platform's build-time env var settings instead).
ARG REACT_APP_API_URL=http://localhost:5000/api/v1
ARG REACT_APP_SOCKET_URL=http://localhost:5000
ENV REACT_APP_API_URL=$REACT_APP_API_URL
ENV REACT_APP_SOCKET_URL=$REACT_APP_SOCKET_URL

RUN npm run build

# --- Runtime: static file server ---
FROM nginx:1.27-alpine AS runtime

COPY --from=builder /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost/ >/dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
