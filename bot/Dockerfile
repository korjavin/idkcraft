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
# idkcraft-e4p4: Node-side cleanup only (not the bead's fix) — more old-space
# headroom; the bead's 626MB heap/GC evidence is the body JVM (body.stats),
# whose heap is raised via the BODY_JVM_ARGS default (compose body2,
# baritone/start.sh). The perception.js churn cut lowers the allocation rate.
ENV NODE_OPTIONS=--max-old-space-size=1536
CMD ["node", "src/index.js"]
