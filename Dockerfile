# 使用官方 Node.js 18 镜像作为基础
FROM node:18-slim

# 安装 Playwright 所需的系统依赖和 Chromium 浏览器
RUN apt-get update && apt-get install -y \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libasound2 \
    libxshmfence1 \
    wget \
    && rm -rf /var/lib/apt/lists/*

# 设置工作目录
WORKDIR /app

# 复制 package.json 并安装 Node.js 依赖
COPY package*.json ./
RUN npm install

# 全局安装 Playwright 并下载 Chromium 浏览器
RUN npx playwright install chromium
RUN npx playwright install-deps chromium

# 复制项目所有文件到容器内
COPY . .

# 暴露端口（Render 会通过环境变量 PORT 注入，这里写 8080 作为默认）
EXPOSE 8080

# 启动服务
CMD ["node", "server.js"]