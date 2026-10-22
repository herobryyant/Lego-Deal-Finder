FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY supabase ./supabase
COPY public ./public
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
