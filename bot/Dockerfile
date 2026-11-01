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
# idkcraft-e4p4: bot2 node heap pinned at its 626MB ceiling for 3+ days
# (2-5s GC/min slowing ticks) — raise the old-space cap; the churn cut in
# perception.js lowers the allocation rate to match.
ENV NODE_OPTIONS=--max-old-space-size=1536
CMD ["node", "src/index.js"]
