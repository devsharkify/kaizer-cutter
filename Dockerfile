FROM node:20-slim
 
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-pip \
      fonts-noto \
      fonts-noto-core \
      fontconfig && \
    pip3 install sarvamai --break-system-packages && \
    fc-cache -fv && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*
 
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
 
COPY index.js .
COPY transcribe.py .
COPY public/ ./public/
 
EXPOSE 3000
CMD ["node", "index.js"]
 
