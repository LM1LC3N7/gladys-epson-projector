# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Epson projectors, over
ESC/VP.net (the network control protocol Epson publishes, TCP port 3629): a
Node.js service (Node 22+, ESM, no build step) that runs in its own sandboxed
Docker container and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template;
the protocol logic is ported from the `epson-projector` Python library (MIT,
see `THIRD_PARTY_NOTICES.md`). Only ESC/VP.net is used: never the HTTP mode
of the library, which imitates the projector's web remote. Decisions are
recorded in `TODO.md`.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "Power"   # tests whose name matches
npm run cover                             # regenerates cover.png
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js registers before connect())
src/handlers.js                   every SDK handler -> EpsonApp (shared with the tests)
src/app.js                        projectors, search, polling, commands, password blocks, status
src/escvp/protocol.js             ESC/VP.net messages and ESC/VP21 frames (pure)
src/escvp/session.js              one TCP session: handshake, one request at a time, bounded answers
src/escvp/client.js               one address: session reuse, idle close
src/escvp/codes.js                commands, power states, source and color mode codes (pure)
src/model.js                      projectors -> Gladys devices and states (pure)
src/store.js                      /data/epson-projector.json
src/constants.js                  frozen keys, limits, timings
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, fake Gladys + fake projector (test/fixtures/)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** Built with `gladys.externalIds('epson', id)`,
  `id` being the serial number (`SNO?`), or the address when the projector
  gives none (see `TODO.md`). Gladys keys devices, their history, scenes and
  dashboards on them: changing one creates a new device and orphans the old
  one. The same goes for every key users store: manifest `config_schema`,
  `actions`, feature keys.
- **No switch** for power: an "everything on / off" must not command a
  projector. Buttons ("Power on", "Standby") and read-only states only.
- **Commands are decided on the state read just before**, never on memory;
  a command that may have left is "sent, without confirmation", never "not
  sent".
- **The password** (config `secret`) is never logged, never written to /data
  nor put in a message. A refused password is persisted as a block per
  address, tried again every 30 minutes or when the configuration is saved,
  never in a loop; a reconnection to Gladys lifts nothing.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (0.1.0 was set once by hand, see `TODO.md`).
  `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code: change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync. Files are
  UTF-8 without BOM (`test/encoding.test.js`), and a secret is never called
  encrypted.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never leave the loopback interface.
