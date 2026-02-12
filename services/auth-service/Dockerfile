FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install && npx prisma generate
RUN npm run build --workspace=@raahi/shared && npm run build --workspace=@raahi/auth-service
ENV NODE_ENV=production
EXPOSE 5001
CMD ["node", "services/auth-service/dist/index.js"]
