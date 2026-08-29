FROM node:18-bullseye

# Java JRE ইনস্টল
RUN apt-get update && apt-get install -y default-jre wget && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Apktool সেটআপ
RUN wget https://raw.githubusercontent.com/iBotPeaches/Apktool/master/scripts/linux/apktool -O /usr/local/bin/apktool && \
    chmod +x /usr/local/bin/apktool && \
    wget https://github.com/iBotPeaches/Apktool/releases/download/v2.9.3/apktool_2.9.3.jar -O /usr/local/bin/apktool.jar

# Uber APK Signer সেটআপ
RUN wget https://github.com/patrickfav/uber-apk-signer/releases/download/v1.3.0/uber-apk-signer-1.3.0.jar -O /usr/local/bin/uber-apk-signer.jar

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
