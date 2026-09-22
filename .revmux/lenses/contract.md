---
description: deploy contract and privacy — compose names, env vars, laya REST shape, secrets and hostnames
---
## Lens: contract

`CLAUDE.md` names a shared contract the deployed stack depends on: services `mc`, `bot`, `laya`; the
env var names in the stack table; the image `ghcr.io/korjavin/idkcraft`; the `laya` REST shape the
bot calls; `ONLINE_MODE=false` with the whitelist. Portainer redeploys from the `deploy` branch on
every merge, so a broken contract breaks the live server, not a test.

Look for:

- a renamed or removed service, env var, port, volume path or REST field that CLAUDE.md lists, or a
  new env var the bot reads that `docker-compose.yml` never passes
- a hostname, domain name, IP address, API key or token written into any file, comment, test fixture,
  PR body or log line — this is **critical**, whatever the file
- a change to `bot/Dockerfile`, `laya/Dockerfile` or CI paths that makes the image build or the
  bot/laya-only build trigger (see `.github/workflows`) stop working
- a new npm dependency that is not in `package-lock.json`, or a plugin loaded that the Docker image
  will not have
- the bot requiring `TYPESAFE_API_KEY` or a reachable brain to start — it must join with the stub

Report only what breaks the deploy or leaks something. Do not review style here.
