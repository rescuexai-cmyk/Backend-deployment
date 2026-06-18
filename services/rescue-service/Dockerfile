FROM node:20-alpine
RUN apk add --no-cache openssl openssl-dev libc6-compat
WORKDIR /app
COPY . .
RUN npm install && npx prisma generate
RUN npm run build --workspace=@raahi/shared && npm run build --workspace=@raahi/rescue-service
ENV NODE_ENV=production
EXPOSE 5009
CMD ["node", "services/rescue-service/dist/index.js"]
