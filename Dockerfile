FROM node:22
WORKDIR /app
COPY . .
ENV PORT=4173
EXPOSE 4173
CMD ["node","server.js"]
