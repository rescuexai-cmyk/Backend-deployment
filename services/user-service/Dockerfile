FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install && npx prisma generate
RUN npm run build --workspace=@raahi/shared && npm run build --workspace=@raahi/user-service
ENV NODE_ENV=production
EXPOSE 5002
CMD ["node", "services/user-service/dist/index.js"]
