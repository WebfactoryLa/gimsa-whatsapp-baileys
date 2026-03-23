FROM node:20-alpine

RUN apk add --no-cache git ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p auth/session

EXPOSE 3100

CMD ["npm", "start"]
