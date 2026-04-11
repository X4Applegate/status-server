FROM node:20-alpine

# Install ping and networking tools
RUN apk add --no-cache iputils

# Create writable config directory owned by node user
RUN mkdir -p /config && chown node:node /config

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY views ./views

ENV PORT=3000
ENV CHECK_INTERVAL=30000
ENV CONFIG_PATH=/config/servers.json

EXPOSE 3000

CMD ["node", "server.js"]