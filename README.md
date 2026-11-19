# Weldall Git app

The Weldall Git app keeps the repositories of people's apps on one Git host (GitHub through a GitHub App, or Forgejo through a bot user). People publish apps with the [Weldall](https://github.com/seibert-external/weldall) CLI or an agent; the Git app creates the repository from a template, hands out short-lived git credentials, proxies git traffic, opens pull requests and reports status. The Git host secret never leaves this service.

It is a separate service that an organisation registers in Weldall as a resource, like any other service (see [Service configuration](https://docs.weldall.ai/service-configuration/) in the Weldall documentation). It is secured with [`@weldall/sdk`](https://www.npmjs.com/package/@weldall/sdk). It keeps the [app registry](#app-registry) (every app, its owner, purpose, links and 90-day re-verification) in its own PostgreSQL database, and talks to Weldall through Weldall's app host API (`/api/app-host/v1`, client in [`src/app-host.ts`](src/app-host.ts)) only for two things: whether a person still holds their permissions, and the audit log. The Git host secret stays in the Git app.

Each running instance serves exactly one Git host. Run two instances (two resources) for GitHub and Forgejo.

Status: third part. Repository creation, pull requests, status, links, the set-up checklist, the app registry, the git credential and the git proxy work against the fake host, fake Weldall and a real PostgreSQL in the tests; the git proxy is also tested with the real `git` client against `git http-backend`. The instance publishes [skills](#skills), and the [Docker image](#docker-image) is built and tested here; releases are not set up in this repository yet. On 19 November 2026 it ran against github.com with a test GitHub App, the real CLI code and a local Weldall development server: checklist, repository from a template, git fetch and push through the proxy, refused pushes, pull request, status, sync, registry and audit (then with the registry still in Weldall). See [Not built yet](#not-built-yet) for what is still unverified.

The documentation for operators and employees is part of the Weldall documentation at [docs.weldall.ai](https://docs.weldall.ai/): running and registering the Git app, the GitHub and Forgejo host set-up, and publishing apps.

## Layout

| Path                                                | What                                                                                                                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                      | Entry point: loads the configuration, opens and migrates the database (fails fast) and serves on `PORT`.                                                                                                       |
| `src/app.ts`                                        | Hono app: the SDK's authorization server routes, `/health`, the protected API routes.                                                                                                                          |
| `src/config.ts`                                     | Environment parsing and validation.                                                                                                                                                                            |
| `src/hosts/`                                        | The Git host interface (`git-host.ts`), the drivers `github/` and `forgejo/`, bounded HTTP (`http.ts`) and the factory (`index.ts`).                                                                           |
| `src/services/`                                     | One module per endpoint: `create-app.ts`, `pull-requests.ts`, `status.ts`, `checklist.ts`, `git-credentials.ts`, `registry-api.ts`, plus `own-app.ts` and the pull request text.                               |
| `src/registry/`                                     | The app registry: the database pool and migrations (`database.ts`, `migrations.ts`), the registry's queries (`registry.ts`) and the re-verification rules (`state.ts`).                                        |
| `src/git/`                                          | The git proxy (`proxy.ts`), signed git credentials (`credentials.ts`), push rules, pkt-line handling, paths and limits.                                                                                        |
| `src/app-host.ts`                                   | Client for Weldall's audit API and subject scope check; a copy of Weldall's contract (see [The app host contract](#the-app-host-contract)).                                                                    |
| `src/access.ts`                                     | Current permission check through Weldall (`checkSubjectScopes`).                                                                                                                                               |
| `src/skills.ts`                                     | The skills the instance publishes through Weldall's skill discovery.                                                                                                                                           |
| `src/audit.ts`                                      | Audit reports to Weldall (`reportAuditEvent`).                                                                                                                                                                 |
| `src/redaction.ts`, `src/git-text.ts`, `src/log.ts` | Credential redaction, sanitising of host text, and the redacting JSON logger.                                                                                                                                  |
| `test/fixtures/`                                    | Fake GitHub and Forgejo APIs (replace the global `fetch`), the in-process fake Weldall app host API, a harness that obtains real access tokens from the instance, and the shared contract fixture `app-host/`. |
| `test/setup/database.ts`                            | Starts the throwaway PostgreSQL the tests use (see [Development](#development)).                                                                                                                               |
| `Dockerfile`, `scripts/`                            | The image (`build-image.mjs` bundles the app and the licence texts of its dependencies) and its black-box test (`test-image.sh`).                                                                              |

## Configuration

Everything comes from the environment. Secrets come only from the environment or from a file whose path is in `<NAME>_FILE` (exactly one of both). The Git app reports every problem at once, by variable name, and never prints a value.

| Variable                                                                         | Required | Meaning                                                                                                                          |
| -------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GIT_APP_HOST`                                                                   | yes      | `github` or `forgejo`.                                                                                                           |
| `GIT_APP_HOST_CONFIG` or `GIT_APP_HOST_CONFIG_FILE`                              | yes      | Host configuration as JSON (see below).                                                                                          |
| `GIT_APP_HOST_SECRET` or `GIT_APP_HOST_SECRET_FILE`                              | yes      | Secret: the GitHub App's private key (PEM as GitHub generated it), or the Forgejo bot user's access token.                       |
| `GIT_APP_PUBLIC_ORIGIN`                                                          | yes      | The instance's public https origin, e.g. `https://git-app.example.com`. It is the issuer of the instance's authorization server. |
| `GIT_APP_RESOURCE_IDENTIFIER`                                                    | no       | Resource identifier registered in Weldall; default `<origin>/api`. The API routes are always under `/api`.                       |
| `GIT_APP_DOWNSTREAM_CLIENT_ID`                                                   | yes      | Downstream client ID registered on the resource in Weldall, e.g. `weldall-cli-at-git-app`.                                       |
| `GIT_APP_SIGNING_KID`, `GIT_APP_SIGNING_PUBLIC_JWK`                              | yes      | Key id and public ES256 JWK of the key the instance signs its own access tokens with.                                            |
| `GIT_APP_SIGNING_PRIVATE_JWK` or `..._FILE`                                      | yes      | Secret: the matching private JWK.                                                                                                |
| `GIT_APP_PUBLISH_SCOPE`                                                          | no       | Default `git-app:publish`.                                                                                                       |
| `GIT_APP_ADMIN_SCOPE`                                                            | no       | Default `git-app:admin`.                                                                                                         |
| `GIT_APP_REGISTRY_READ_SCOPE`                                                    | no       | Default `git-app:registry-read`: machine clients reading the [app registry](#app-registry).                                      |
| `GIT_APP_DATABASE_URL` or `GIT_APP_DATABASE_URL_FILE`                            | yes      | Secret: PostgreSQL connection URL of the app registry, e.g. `postgres://git_app:…@db.example.com:5432/git_app`.                  |
| `GIT_APP_GIT_CREDENTIAL_KEY` or `..._FILE`                                       | yes      | Secret: base64 of at least 32 random bytes (`openssl rand -base64 32`). Signs and verifies git credentials.                      |
| `GIT_APP_GIT_CREDENTIAL_PREVIOUS_KEY` or `..._FILE`                              | no       | Secret: the previous key during a rotation; only verifies. Must differ from the current key.                                     |
| `WELDALL_ISSUER`                                                                 | yes      | Weldall's origin, e.g. `https://weldall.example.com`.                                                                            |
| `WELDALL_MACHINE_CLIENT_ID`, `WELDALL_MACHINE_KID`, `WELDALL_MACHINE_PUBLIC_JWK` | yes      | The Weldall machine client the instance uses for the app host API, its key id and public ES256 JWK.                              |
| `WELDALL_MACHINE_PRIVATE_JWK` or `..._FILE`                                      | yes      | Secret: the machine client's private JWK.                                                                                        |
| `PORT`                                                                           | no       | Default `3002`.                                                                                                                  |

The host configuration is validated by `src/hosts/github/config.ts` and `src/hosts/forgejo/config.ts`. GitHub:

```json
{
  "appId": "123456",
  "organization": "example-apps",
  "installationId": "987654",
  "apiBaseUrl": "https://api.github.com",
  "templates": [{ "name": "react", "repository": "example-apps/react-starter" }],
  "repositoryNamePrefix": "app-",
  "reviewerTeam": "app-reviewers",
  "setupMode": "customer-managed",
  "liveEnvironments": ["production"]
}
```

`installationId` is looked up from the organisation when omitted; `apiBaseUrl` defaults to `https://api.github.com` (or `https://api.<subdomain>.ghe.com`). Forgejo:

```json
{
  "baseUrl": "https://git.example.com",
  "organization": "example-apps",
  "botUser": "weldall-bot",
  "templates": [{ "name": "react", "repository": "example-apps/react-starter" }],
  "repositoryNamePrefix": "app-",
  "reviewerTeam": "app-reviewers",
  "setupMode": "customer-managed",
  "previewStatusContext": "weldall/preview",
  "liveStatusContext": "weldall/live"
}
```

Only `customer-managed` is built: the organisation provides the default-branch rules, the reviewer team's write access and CI secrets; the Git app checks them.

## Set-up in Weldall

1. Create the scopes `git-app:publish` (create apps, open pull requests, read status, list and confirm one's own apps), `git-app:admin` (run the set-up checklist, see every app, register an existing repository) and `git-app:registry-read` (machine clients reading the registry), or the names configured above. Several instances share them: the CLI finds a Git app only by the first two (see [How the CLI finds and trusts this instance](#how-the-cli-finds-and-trusts-this-instance)).
2. Register the resource: resource identifier `https://git-app.example.com/api`, authorization server `https://git-app.example.com`, downstream client ID as configured, request prefix `https://git-app.example.com/api`, scopes `git-app:publish`, `git-app:admin` and `git-app:registry-read`.
3. Register a machine client with the instance's machine public key. Allow it the Git app's own resource, and the system scopes `weldall:app-host` and `weldall:subject-scopes-check`.
4. Assign `weldall:login` and `git-app:publish` to the people who publish apps, and `git-app:admin` to the administrators who run the checklist and review the registry.
5. For each of the organisation's own tools that reads the registry (a CMDB import, a report), register a machine client and allow it this resource with `git-app:registry-read`.
6. Switch on skill discovery for the resource, so the [skills](#skills) appear in the catalog.

## Skills

The instance publishes three skills at `/.well-known/weldall-skills` (`src/skills.ts`). Weldall prefixes the local ids with the resource key, e.g. `git-app.publish-app`. The texts are generated from the configuration: the host's name and protected paths, the scopes and the public origin. `publish-app` is `DEFAULT`, so Weldall shows its full text to every user; it must not carry organisation details such as template or team names.

| Id                | Required scope                              | Visibility            | What it tells the agent                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------- | ------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `publish-app`     | `GIT_APP_PUBLISH_SCOPE` (`git-app:publish`) | `DEFAULT`             | Publish with the client's `publish_app` tool or `weldall app publish` (and `app status`, `app sync`, `app list`, `app confirm`); how to handle `conflict`, `refused`, `pull_request_not_opened` and interruptions; that nothing personal goes into the organisation's Git; that a reviewer of the organisation merges. Shown without the scope too, so the agent can name what is missing.                                           |
| `admin-apps`      | `GIT_APP_ADMIN_SCOPE` (`git-app:admin`)     | `HIDDEN_IF_UNALLOWED` | List the app registry (`weldall request … /api/admin/apps`, flagged apps first) and register an existing repository for its owner (`POST /api/admin/apps`), with the rules for names and purposes as untrusted text and for asking the administrator for every value.                                                                                                                                                                |
| `admin-checklist` | `GIT_APP_ADMIN_SCOPE` (`git-app:admin`)     | `HIDDEN_IF_UNALLOWED` | Run the set-up checklist with `weldall app checklist --json` (optionally `--app <id>`, and `--git-app <key>` when Weldall lists several Git apps) and present it; on Forgejo, the warning about workflows pushed onto a publish branch. With other scope names than the defaults, the CLI's `app` commands do not find the instance, so the text falls back to `weldall request --scope <admin scope> <origin>/api/admin/checklist`. |

The publish skill names only the CLI commands and client tools, never this instance's URLs: the CLI finds the instance in Weldall's resource registry. Revisit the text when the CLI changes.

## How the CLI finds and trusts this instance

The Weldall CLI (`apps/cli/src/git/git-apps.ts` in the Weldall repository) treats a registered resource as a Git app when it supports `git-app:publish` (or `git-app:admin` for the checklist) and its authorization server is a bare https origin: that origin must therefore be `GIT_APP_PUBLIC_ORIGIN`, the API must be accepted by a request prefix `<origin>/api`, and the git route is `<origin>/git/`. Weldall's resource registry has no marker for Git apps, so **an instance with other scope names is not found** by `weldall app …`. The first publish picks the only Git app the person may publish with, or the one `--git-app <resource key>` names; the folder records the key. The CLI sends a token or a git credential only to the origin Weldall lists for that key, and refuses a folder whose stored git URL lies anywhere else (also after the instance moved to another origin in Weldall; the error names the new address).

## Docker image

`docker.io/seibertgroup/weldall-git-app`. The image bundles `@weldall/sdk`, so an SDK update needs a new image. This repository has no release workflow yet; images were released from the Weldall repository until the Git app moved here.

The image is `node:24-bookworm-slim` with one bundled file (`/app/index.mjs`, built by `scripts/build-image.mjs` with esbuild) and the licence texts of the bundled packages (`/app/THIRD_PARTY_NOTICES`). It runs as the unprivileged `node` user, listens on `PORT` (default `3002`), checks `/health`, stops on `SIGTERM` (see below), and contains no configuration or secret.

```sh
pnpm image:build   # weldall-git-app:local, built from the repository root
pnpm image:test    # build, then scripts/test-image.sh (needs docker, curl and node)
```

Run it with the configuration from the environment and the secrets from mounted files (one instance per Git host; terminate HTTPS in front of it at the origin in `GIT_APP_PUBLIC_ORIGIN`):

```sh
docker run -d --name weldall-git-app -p 3002:3002 \
  -e GIT_APP_HOST=github \
  -e GIT_APP_HOST_CONFIG_FILE=/run/secrets/host.json \
  -e GIT_APP_HOST_SECRET_FILE=/run/secrets/github-app.pem \
  -e GIT_APP_PUBLIC_ORIGIN=https://git-app.example.com \
  -e GIT_APP_DOWNSTREAM_CLIENT_ID=weldall-cli-at-git-app \
  -e GIT_APP_SIGNING_KID=git-app-1 \
  -e GIT_APP_SIGNING_PUBLIC_JWK='{"kty":"EC","crv":"P-256","x":"…","y":"…"}' \
  -e GIT_APP_SIGNING_PRIVATE_JWK_FILE=/run/secrets/signing.jwk \
  -e GIT_APP_GIT_CREDENTIAL_KEY_FILE=/run/secrets/git-credential.key \
  -e WELDALL_ISSUER=https://weldall.example.com \
  -e WELDALL_MACHINE_CLIENT_ID=git-app-machine \
  -e WELDALL_MACHINE_KID=machine-1 \
  -e WELDALL_MACHINE_PUBLIC_JWK='{"kty":"EC","crv":"P-256","x":"…","y":"…"}' \
  -e WELDALL_MACHINE_PRIVATE_JWK_FILE=/run/secrets/machine.jwk \
  -e GIT_APP_DATABASE_URL_FILE=/run/secrets/database-url \
  -v /srv/git-app/secrets:/run/secrets:ro \
  docker.io/seibertgroup/weldall-git-app:X.Y.Z
```

On `SIGTERM` the Git app stops accepting requests and gives running ones at most 8 seconds (fixed in `src/index.ts`) before it exits; a push or fetch still running then is cut off, and the client sees a failed transfer. Keep the orchestrator's stop timeout at 10 seconds or more (`docker stop --time`, Compose `stop_grace_period`, Kubernetes `terminationGracePeriodSeconds`) so the process ends on its own. A longer stop timeout alone does not let longer transfers survive a stop: that also needs a longer grace in `src/index.ts`. Stop or redeploy an instance when no publish is running.

The mounted files must be readable by uid 1000. A missing or invalid configuration stops the container at start (exit code 1) with every problem named by variable, never by value; so does a database that cannot be reached or migrated (the message names `GIT_APP_DATABASE_URL` and at most the error code, e.g. `ECONNREFUSED`). Run one replica per instance (see [Not built yet](#not-built-yet)). `pnpm image:test` starts a throwaway `postgres:17-alpine` on a private Docker network for the image (`GIT_APP_TEST_DATABASE_IMAGE` overrides the image).

## API

All routes except `/api/registry/apps` need a DPoP-bound user access token from the instance's own token endpoint (Weldall's ID-JAG exchange, as for every resource). Apps belong to people, so machine tokens get `403` there. Every person's route first asks Weldall whether the person still holds `weldall:login` and the route's scope (`checkSubjectScopes`); without an answer from Weldall nothing happens on the host (`503`). A registry that cannot be reached is `503 registry_unavailable`. Errors are `{ error, error_description }`.

| Method and path                     | Scope           | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                       | none            | `{ "status": "ok" }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /api/apps`                    | `publish`       | `{ template, name, purpose }`: creates the private repository from the template and registers the app for the person. Repeating the call resumes the same owner's repository. Another person's name is `409 app_exists`. Audited as `git_repository.created`/`.denied`/`.failed`. The answer carries `git: { remotePath, remoteUrl }` (this instance's `/git/<owner>/<repository>.git`).                                                                                                                                                                                                                                                                                |
| `GET /api/apps`                     | `publish`       | `{ resource, apps, reverificationDays, expiringSoonDays }`: the person's apps (see [App registry](#app-registry) for an entry), expired and expiring ones first. Records the email address of the person's token on their entries. Not audited.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST /api/apps/{id}/confirm`       | `publish`       | No body. The owner confirms that the app is still needed: the expiry moves to 90 days from now, `confirmedAt`/`confirmedBy` are set. Answers `{ app }`. Another person's app and an unknown id are the same `404`. The change and `app_confirmation.succeeded` in Weldall commit together (`503 audit_unavailable`, nothing changed); refusals are audited as `app_confirmation.denied`.                                                                                                                                                                                                                                                                                |
| `GET /api/apps/{id}`                | `publish`       | `{ app, git: { remotePath, remoteUrl } }`: one of the person's apps as the registry has it (with `ready`, `defaultBranch` and the template commit); another person's app and an unknown id are the same `404`.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /api/apps/{id}/pull-requests` | `publish`       | `{ head, title, body }`: opens the pull request from a `weldall/publish-*` branch into the default branch. The body starts with a hidden marker and `Published with Weldall (Weldall user <id>).`, never a name. Requests the reviewer team. Audited with the pull request's commits.                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /api/apps/{id}/status`         | `publish`       | Pull request state, reviews (sanitised text), checks, preview and live links, protected paths and the commit identity. `?branch=weldall/publish-…` picks a branch. New links are written to the registry. Not audited (the contract has no event for reads). On GitHub a permission the installation lacks is a warning; its refused token request is not repeated for that repository for 5 minutes (`TOKEN_REFUSAL_TTL_MS`).                                                                                                                                                                                                                                          |
| `POST /api/git-credentials`         | `publish`       | `{ path: "git/<owner>/<repository>.git", access?: "read" \| "write" }` (read unless write is asked for) returns `{ username, password, expiresAt }` for git's Basic auth, valid 5 minutes and only at this instance's `/git/` route. Only for the person's own ready app; 20 per person and minute per instance. Handed out only after Weldall stored `git_credential.issued` (`503 audit_unavailable` otherwise); refusals audited as `.denied`/`.failed`.                                                                                                                                                                                                             |
| `GET /api/admin/checklist`          | `admin`         | The host's set-up checklist (`weldall app checklist`). `?app=<id>` names a ready app whose repository the rule and team checks use. Read-only on the host; audited as `git_host.checked`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/admin/apps`               | `admin`         | `{ resource, apps, total, page, pageSize, reverificationDays, expiringSoonDays }`: every app with its owner, expired and expiring ones first. Query, each at most once: `state` (`active`, `expiring_soon`, `expired`), `q` (name, purpose, repository, owner id or email, case-insensitive), `page`, `pageSize` (1-200, default 50). Not audited.                                                                                                                                                                                                                                                                                                                      |
| `POST /api/admin/apps`              | `admin`         | `{ owner, repository, name, purpose }`: registers an existing private repository of the organisation (created on the host without publishing, e.g. from a template; INV-185) as an app of `owner` (a Weldall user id holding `weldall:login` and the publish scope, else `409 owner_not_allowed`). Not a template (`409 repository_is_template`); reviewer team and branch rules are checked as for a new repository. Ready at once. Answers `{ created, app, warnings }`; repeating it for the same owner returns the entry. The entry and `git_repository.registered` (the administrator as subject) commit together; refusals are `git_repository.denied`/`.failed`. |
| `GET /api/registry/apps`            | `registry-read` | Machine clients only (people get `403`): the whole registry for the organisation's own tools, `{ resource, apps, nextCursor, generatedAt, reverificationDays, expiringSoonDays }`, oldest first so paging neither repeats nor skips. Query, each at most once: `limit` (1-200, default 100), `cursor` (the previous page's `nextCursor`; `null` on the last page), `state`. The token is a Weldall machine token for this resource (`requestMachineToken` with `git-app:registry-read`). Not audited.                                                                                                                                                                   |

### Git credentials

A git credential is signed, not stored: `wgc_<key id>.<payload>.<mac>`, where the payload names the person, the app, its repository, read or write access, the expiry (5 minutes) and a random id, and the MAC is HMAC-SHA256 under `GIT_APP_GIT_CREDENTIAL_KEY` over the payload and the instance's resource identifier (so one instance's credential is useless at another, even with the same key). The random id is the `credentialId` in the audit; the credential itself is never logged or audited, and the `wgc_` prefix keeps it inside the redaction patterns.

Rotation: generate a new key, set it as `GIT_APP_GIT_CREDENTIAL_KEY` and the old one as `GIT_APP_GIT_CREDENTIAL_PREVIOUS_KEY`, restart, and remove the previous key after 5 minutes. Removing a key without a previous slot invalidates every credential it signed; nothing else can revoke a single credential, which is why every git request checks the person with Weldall again.

### Git route

`/git/<owner>/<repository>.git` serves git's smart HTTP only: `GET …/info/refs?service=git-upload-pack|git-receive-pack`, `POST …/git-upload-pack`, `POST …/git-receive-pack`; everything else is `404`. Authentication is Basic with a git credential (the user name is ignored); without one the answer is `401` with `WWW-Authenticate: Basic`, which is how git always starts and is not audited. Traffic is streamed in both directions, never buffered.

On every request, in this order:

1. The credential's signature and expiry; it must name this repository (case-insensitively) and, for a push, write access. An invalid or expired credential is `401`; only the expired one is audited (it was signed by this instance and names the person), a made-up one is only logged, so nobody can write to Weldall's audit log without a credential.
2. A transfer slot (concurrency limit, `429`/`503` with `Retry-After`), held until the response ends. For a push, the ref update commands are then read (at most 64 KB, before the pack), so every later refusal reaches git as `! [remote rejected] <ref> (<reason>)`.
3. Without caching: Weldall's `checkSubjectScopes` (login permission and publish scope) and the registry's entry for the repository (the credential's app, still owned by the person, in this instance's organisation, ready). Without both answers nothing is forwarded and git shows `weldall: Weldall could not be reached …` or that the app registry could not be reached.
4. The host token, minted for this repository and operation (`GitHost.getForwardingTarget`: GitHub `contents: read` or `write` for this one repository; Forgejo's bot token cannot be narrowed).
5. Pushes: the push rules (only `weldall/publish-*` branches, never the default branch, no deletes, no tags, at most 5 refs, no push options or signed pushes, only known capabilities, a status report required), the pull request state of each branch (closed or merged is refused), then `git_push.forwarded` must be stored in Weldall before the push is forwarded; otherwise git shows `the audit log is unavailable, nothing was pushed`. The expected old value of each ref is enforced by the host's receive-pack.
6. After the host answered: `git_push.completed` (or `.failed` with the host's refusal) with ref updates, sizes, duration and status; fetches: `git_fetch.completed`/`.failed` when the response ends. Fetches are not gated on an audit entry (the contract has no event before a fetch); a completion that Weldall cannot store is logged with the same fields.

Every refusal after the credential was verified is reported as `git_push.denied`/`.failed` or `git_fetch.denied`/`.failed` (best effort), always with the requested repository. A refusal before the app is resolved (a read-only push, a revoked scope) names the app of the credential, which is signed and unexpired at that point. A credential for another repository, or an app that now belongs to someone else, is never linked. Limits (`src/git/limits.ts`): push 100 MiB (declared size refused up front, otherwise counted while streaming), fetch response 1 GiB, 280 s per request, 16 concurrent transfers per instance and 4 per person (`429`/`503` with `Retry-After`). A client that leaves aborts the upstream request; a push the host already received is read to the end and audited.

### Order of side effects when creating an app

1. Weldall: permission check. Registry: lookup (name free or the person's own).
2. Host: create the private repository from the template.
3. Registry: register the app, not ready yet (template commit null), right after the host confirmed the repository.
4. Host: wait for the default branch, check the reviewer team and branch rules.
5. Weldall: report `git_repository.created`.
6. Registry: set the template commit, which makes the app ready.

An app becomes ready only after its audit entry is stored. If step 5 or 6 fails, the person gets `503` and a repeat resumes and reports again. Step 3 is retried once when the registry could not be reached. If it still fails, the repository may exist without a registry entry: it is reported as `git_repository.failed` with the repository name (best effort) and logged, it cannot be used (the git proxy will serve only ready apps), and an administrator must delete it or register it (`POST /api/admin/apps`).

## App registry

Every app this instance keeps a repository for is in its registry (INV-183), in the PostgreSQL database `GIT_APP_DATABASE_URL` names: apps published with the CLI (entered at the first publish, step 3 above) and existing repositories an administrator registers (`POST /api/admin/apps`). The schema is in [`src/registry/migrations.ts`](src/registry/migrations.ts): plain SQL, applied in order at every start inside one transaction per migration, serialised by an advisory lock, recorded in `schema_migrations`. A database migrated by a newer Git app is refused at start. Each instance needs its own database (or schema); the instance's database user must be allowed to create tables in it.

One entry, as `GET /api/apps` shows it (administrators and tools also get `owner: { id, email }`, `registeredBy` and `confirmedBy`):

```json
{
  "id": "app_3f2a9c0d1e4b5a6f7081",
  "name": "expenses",
  "purpose": "Tracks team expenses until the finance tool supports receipts.",
  "repository": {
    "owner": "example-apps",
    "name": "app-expenses",
    "webUrl": "https://github.com/example-apps/app-expenses"
  },
  "template": "react",
  "links": { "preview": null, "live": "https://expenses.example.com/" },
  "createdAt": "2026-11-02T09:14:00.000Z",
  "confirmedAt": null,
  "expiresAt": "2027-01-31T09:14:00.000Z",
  "state": "active"
}
```

- **Re-verification**: a new entry expires 90 days after it was created. Only the owner's confirmation moves the expiry (to 90 days from then); publishing, links and registrations never do. The state is derived on every read: `active`, `expiring_soon` (14 days or less before the expiry) and `expired` (from the expiry on). An expired app is only flagged: publishing and the git proxy keep working, nothing is deleted, and no notification is sent.
- **Owner**: the Weldall user id (`sub`) of the verified token that created the entry, or the id an administrator named. The email address is the one in the owner's last token (user tokens always carry a verified one); it is null for an administrator's registration until the owner has listed or confirmed their apps. Names are not kept: Weldall's directory has them, by id or email.
- **Who sees what**: the owner sees and confirms only their own apps (`publish`); administrators see all (`admin`); the organisation's own tools read all through a machine client (`registry-read`). Names, purposes and links come from people or from CI; clients must treat them as text.
- **Attribution**: entries record who registered (`registeredBy`) and who confirmed last (`confirmedBy`, `confirmedAt`). Registrations and confirmations are also reported to Weldall's audit log (`git_repository.created`, `git_repository.registered`, `app_confirmation.succeeded`/`.denied`) before they count. Rejections are reported best effort; when Weldall cannot store one, it is logged.

## The app host contract

Weldall defines the app host API in its own repository (`packages/sdk/src/app-host.ts`); that part is not published with `@weldall/sdk`. [`src/app-host.ts`](src/app-host.ts) is this service's copy of it, and Weldall is the authority: change the copy when Weldall's contract changes. Since the registry moved here, the copy is ahead of Weldall's: Weldall keeps no app records, every event that names an app also names its repository, and it adds `git_repository.registered` and `app_confirmation.succeeded`/`.denied`; Weldall's side still has to follow. Both repositories check their side against the same example request, [`test/fixtures/app-host/audit-event-request.json`](test/fixtures/app-host/audit-event-request.json): here, `test/app-host.test.ts` asserts that the client sends exactly that body; Weldall keeps an identical copy for the endpoint side. Keep the two copies identical.

The credential redaction rules in [`src/redaction.ts`](src/redaction.ts) are likewise identical to Weldall's `apps/weldall/src/server/observability/redaction.ts`. No test can compare them across repositories, so change both together.

## Development

Needs Node.js 22.15 or later, pnpm 11 (`corepack enable`), `git` for the git proxy tests, and Docker for the tests' PostgreSQL.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build          # tsc to dist/; `pnpm start` runs it
pnpm dev            # tsx src/index.ts, configured from the environment
pnpm format:check
```

The tests use no external network: the GitHub and Forgejo APIs are fixtures that replace `fetch`, Weldall is an in-process fake that validates every request against the contract schemas in `src/app-host.ts`, and the git proxy runs the real `git` client against `git http-backend` on 127.0.0.1. The registry runs against a real PostgreSQL: `pnpm test` starts a throwaway `postgres:17-alpine` container (`weldall-git-app-test-db-<pid>`, loopback only, data in tmpfs) and removes it at the end; every test instance gets its own schema. Set `GIT_APP_TEST_DATABASE_URL` to use a server you run yourself (CI), and `GIT_APP_TEST_DATABASE_IMAGE` for another image.

## Not built yet

- **CI and release**: this repository has no GitHub Actions workflows yet.
- **CLI**: switched to this instance (`weldall app publish|sync|status|checklist`, `weldall git-credential`); tested against fakes and in the live run above. `weldall app list` and `weldall app confirm` still call Weldall's former registry and must move to `GET /api/apps` and `POST /api/apps/{id}/confirm` here. The sandbox door for the credential helper (INV-133) does not exist yet.
- **Registry**: no user interface (administrators use the `admin-apps` skill), no notifications to owners of expiring apps, no deletion or owner transfer, and no backup set-up: back up the database like any other.
- **Docker Hub**: the repository `seibertgroup/weldall-git-app` must exist and be public before the first release (the floating-tag plan reads its public tag list), and the release token must be allowed to push to it.
- **Shared state**: DPoP proofs are replay-checked in memory, and the transfer and credential limits are per process, so run one replica per instance until a shared store is configured.
- **Live verification**, still missing: a browser login (the live run used a prepared session), the production build and the Docker image in a deployment, registration through the admin UI or IaC, skill discovery, a reviewer team that really has write access (its answer was simulated) and a real branch rule, checks, commit statuses, deployments and the preview/live links (the test App lacked those permissions), Forgejo, public hosting, the limits under load, and the sandbox.

## License

[Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (FSL-1.1-ALv2), like Weldall.
