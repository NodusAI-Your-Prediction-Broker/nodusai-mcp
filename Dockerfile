FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy source
COPY src/ ./src/

# Data directory for query registry
RUN mkdir -p data

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "src/server-http.js"]
