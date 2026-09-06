FROM node:22-slim
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm i --no-save typescript@5.9.3 @types/node@24 @types/express@5 && npm run build && rm -rf node_modules/typescript

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/index.js"]
