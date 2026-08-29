# ---------------------------------------------------------------------------
# HTML-to-APK Compilation Service - Dockerfile
# Base: node:18-bullseye
# Installs: OpenJDK (for apktool/apksigner), apktool, uber-apk-signer
# ---------------------------------------------------------------------------
FROM node:18-bullseye

ENV DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
# System dependencies
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-17-jre-headless \
    wget \
    curl \
    unzip \
    zip \
    ca-certificates \
    fontconfig \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# ---------------------------------------------------------------------------
# Java environment
# ---------------------------------------------------------------------------
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# ---------------------------------------------------------------------------
# Install Apktool (wrapper script + jar) into /usr/local/bin
# Uses a pinned, known-good release to avoid breaking on upstream changes.
# ---------------------------------------------------------------------------
RUN wget -q "https://raw.githubusercontent.com/iBotPeaches/Apktool/master/scripts/linux/apktool" \
        -O /usr/local/bin/apktool \
    && wget -q "https://bitbucket.org/iBotPeaches/apktool/downloads/apktool_2.9.3.jar" \
        -O /usr/local/bin/apktool.jar \
    && chmod +x /usr/local/bin/apktool /usr/local/bin/apktool.jar \
    && sed -i 's/apktool.jar/apktool.jar/' /usr/local/bin/apktool

# ---------------------------------------------------------------------------
# Install uber-apk-signer into /usr/local/bin
# ---------------------------------------------------------------------------
RUN wget -q "https://github.com/patrickfav/uber-apk-signer/releases/download/v1.3.0/uber-apk-signer-1.3.0.jar" \
        -O /usr/local/bin/uber-apk-signer.jar

# Sanity check: fail the build early if the tools are missing/corrupt
RUN java -jar /usr/local/bin/apktool.jar --version \
    && java -jar /usr/local/bin/uber-apk-signer.jar --version

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Working directories used at runtime. base.apk MUST be supplied by you
# (place your signed/unsigned template APK at /app/base.apk before building
# the image, or mount it as a volume).
RUN mkdir -p /app/uploads /app/builds /app/workspace \
    && chmod -R 777 /app/uploads /app/builds /app/workspace

ENV NODE_ENV=production
ENV PORT=10000

EXPOSE 10000

CMD ["node", "server.js"]
