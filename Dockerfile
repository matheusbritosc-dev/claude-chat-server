FROM node:20-alpine

# ffmpeg + fontes para drawtext
RUN apk add --no-cache ffmpeg ttf-dejavu

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p tmp/videos logs assets/music assets/fonts

EXPOSE 3457
CMD ["node", "orchestrator.js"]
