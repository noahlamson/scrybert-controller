# scrybert-controller

Front-end for the Scrybert Controller, the prompt CMS. Static files only.

- **Deploys to** `/var/www/controller` on the VPS, served by Apache.
- **No service, no build step.** Changes are live on the next request. `deploy` is not
  required here and does nothing useful - it only resets a working tree and bounces a
  Python service this repo does not have.
- **The server half lives elsewhere.** The `/v1/controller/*` routes, the `core_*` tables
  and the migration are in the `scrybert` repo, not this one.
- **Same origin by design.** `/v1/controller/*` proxies to `:8091` on the same vhost, so no
  CORS middleware is needed and none should be added.

## Spec

Factorum resource `proposals/1.3-controller`, project `scrybert`, owner `development`.
Read the AMENDMENTS block at the top first - it supersedes the original spec beneath it.

## Pushing

Direct HTTPS to `pm.factory226.com`, repo target `scrybert-controller`. See the Factorum
resource `tool/deploy/credentials`. Do not hand-copy base64 through a conversation.

Note: `push_files` cannot bootstrap an empty repo - it reads `git rev-parse HEAD` first and
fails on an unborn HEAD. This repo was seeded with one manual commit on 2026-09-12.
