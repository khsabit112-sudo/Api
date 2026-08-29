FROM node:18-bullseye

# Java ও প্রয়োজনীয় টুলস ইনস্টল
RUN apt-get update && apt-get install -y default-jre-headless wget && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Apktool ডাউনলোড ও সেটআপ
RUN wget https://raw.githubusercontent.com/iBotPeaches/Apktool/master/scripts/linux/apktool -O /usr/local/bin/apktool && \
    chmod +x /usr/local/bin/apktool && \
    wget https://bitbucket.org/iBotPeaches/apktool/downloads/apktool_2.9.3.jar -O /usr/local/bin/apktool.jar

# Uber-APK-Signer ডাউনলোড
RUN wget https://github.com/patrickfav/uber-apk-signer/releases/download/v1.3.0/uber-apk-signer-1.3.0.jar -O /usr/local/bin/uber-apk-signer.jar

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
