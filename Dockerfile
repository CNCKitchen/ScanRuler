FROM node:24-alpine3.24 AS builder

WORKDIR /app/

COPY ./package.json .
COPY ./package-lock.json .
RUN npm install

COPY ./ .
RUN npm run build

FROM nginx:1.31.5-alpine
COPY --from=builder /app/dist /usr/share/nginx/html