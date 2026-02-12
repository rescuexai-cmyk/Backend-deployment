FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install && npx prisma generate
RUN npm run build --workspace=@raahi/shared && npm run build --workspace=@raahi/pricing-service
ENV NODE_ENV=production
EXPOSE 5005
CMD ["node", "services/pricing-service/dist/index.js"]
