FROM node:20-slim

RUN apt-get update -y && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      fonts-noto \
      fonts-noto-core \
      fontconfig && \
    fc-cache -fv && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev

COPY index.js .

EXPOSE 3000
CMD ["node", "index.js"]
