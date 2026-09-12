FROM node:24-alpine3.24

WORKDIR /app/

COPY ./package.json .
COPY ./package-lock.json .
RUN npm install

COPY ./index.html .
COPY ./tsconfig.json .
COPY ./vite.config.ts .

CMD ["npm", "run", "dev", "--", "--host"]