FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install && npx prisma generate
RUN npm run build --workspace=@raahi/shared && npm run build --workspace=@raahi/notification-service
ENV NODE_ENV=production
EXPOSE 5006
CMD ["node", "services/notification-service/dist/index.js"]
