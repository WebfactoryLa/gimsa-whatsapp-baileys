FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

# Crear directorio para sesión de WhatsApp
RUN mkdir -p auth/session

EXPOSE 3100

CMD ["npm", "start"]
