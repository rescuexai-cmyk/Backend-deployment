FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install && npx prisma generate
RUN npm run build --workspace=@raahi/shared && npm run build --workspace=@raahi/driver-service
ENV NODE_ENV=production
EXPOSE 5003
CMD ["node", "services/driver-service/dist/index.js"]
