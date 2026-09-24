FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
# Bot disk memory (idkcraft-hlk): the bot runs as USER node, so the memory
# dir must exist and belong to node before the switch — both for the image
# default and as the seed ownership of the named volume.
RUN mkdir -p /app/memory && chown node:node /app/memory
USER node
CMD ["node", "src/index.js"]
