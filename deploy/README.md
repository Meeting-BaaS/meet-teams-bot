# Cloud image and preprod pipeline

`deploy/Dockerfile` is the image Meeting BaaS runs in the cloud (`web-based-bots-v2`): this bot plus the `@meeting-baas/sqs-consumer` orchestrator from GitHub Packages (pinned in `deploy/bots-runtime/`), started by `deploy/start.sh`. The serverless open-source image is the root `Dockerfile`; the two share nothing but the source tree.

## What deploys when

| Event | What happens |
|---|---|
| PR to `preprod` or `v2-improvements` | type-check and unit tests (`ubuntu-latest`), CI script validation |
| Push to `preprod` (a merged PR) | build `deploy/Dockerfile` at that commit, push `web-based-bots-v2:<date>-<sha>` to the preprod bots registry, roll the meet/teams pools on preprod (`meet-teams-bots-v2 upgrade`) |
| Actions → Run workflow | same as a push, by hand |
| `vX.Y.Z` tag | nothing here: the tag is written by the monorepo's release |

Prod is released from [meeting-baas-v2](https://github.com/Meeting-BaaS/meeting-baas-v2): a `vX.Y.Z` tag on its `main` checks this repository's `v2-improvements` out, builds `deploy/Dockerfile` from it, rolls every service, and creates the same tag here at the commit it built. So the promotion path is: feature branch → PR to `preprod` (rolls preprod) → PR `preprod` → `v2-improvements` → release from the monorepo.

## Building by hand

```bash
NPM_TOKEN=<PAT with read:packages> ENVIRON=preprod .ci/scripts/build-image.sh --image-tag local
```

The token only reaches the build as a BuildKit secret (the orchestrator install); it is never in a layer. `.ci/scripts/deploy.sh --service meet-teams-bots --environment preprod --image-tag <tag>` rolls preprod from a checkout of `kubernetes-config-private` (`DEPLOYMENT_DIR`, default `.ci/deployment` as made by `checkout-deployment.sh`).

## Secrets and variables

- `SCW_SECRET_ACCESS_KEY` (repository secret): registry login for the push.
- `CI_GITHUB_TOKEN` (organisation secret): clones `kubernetes-config-private` at deploy time.
- `DEPLOYMENT_REF` (organisation variable): branch of `kubernetes-config-private` to deploy with; `v2` when unset.
- `GITHUB_TOKEN`: reads `@meeting-baas/sqs-consumer` from GitHub Packages (`permissions: packages: read`; each package grants this repository access once).
- The `baas-k8s-runner` self-hosted runner group must allow this (public) repository.
