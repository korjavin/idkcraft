FROM node:26-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
# Promoted generated skills (idkcraft-vf8e.2): read only under BOT_SKILLS=1.
COPY skills/ ./skills/
# Bot disk memory (idkcraft-hlk): the bot runs as USER node, so the memory
# dir must exist and belong to node before the switch — both for the image
# default and as the seed ownership of the named volume.
RUN mkdir -p /app/memory && chown node:node /app/memory
USER node
CMD ["node", "src/index.js"]
