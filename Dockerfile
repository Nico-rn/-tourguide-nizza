# Schlankes Node.js-Image (Debian-basiert)
FROM node:22-slim

WORKDIR /app

# Erst nur package.json kopieren -> Docker cached den npm install,
# solange sich die Dependencies nicht ändern
COPY package*.json ./
RUN npm install --omit=dev

# Restlichen Code kopieren
COPY server.js ./
COPY planning.js ./
COPY public ./public

EXPOSE 3000

CMD ["node", "server.js"]
