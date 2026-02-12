FROM node:20-alpine
RUN apk add --no-cache openssl openssl-dev libc6-compat
WORKDIR /app
COPY . .
RUN npm install && npx prisma generate
RUN npm run build --workspace=@raahi/shared && npm run build --workspace=@raahi/gateway
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "services/gateway/dist/index.js"]
