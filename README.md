# gladys-epson-projector

[Gladys Assistant](https://gladysassistant.com) external integration for
**Epson projectors**, on the local network: power on, standby, source, color
mode, A/V mute and lamp hours, through **ESC/VP.net** (TCP port 3629, the
network control protocol Epson publishes), without any cloud. Unofficial, not
affiliated with Epson.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress.** First milestone, tested against a fake projector only,
> never with a real Epson projector.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (EpsonApp)
                                   ├─ src/escvp/client.js    one address: session reuse, idle close
                                   ├─ src/escvp/session.js   one TCP session: handshake, one request at a time, bounded answers
                                   ├─ src/escvp/protocol.js  ESC/VP.net messages, ESC/VP21 frames (ported, pure)
                                   ├─ src/escvp/codes.js     commands, power states, source and color mode codes (ported)
                                   ├─ src/model.js           projectors -> Gladys devices and states (pure)
                                   └─ src/store.js           /data/epson-projector.json: projectors, password blocks
```

- **Projectors** are added by IP address (configuration), or found with
  `gladys.scanNetwork('udp-active-broadcast')`: the core broadcasts the
  ESC/VP.net HELLO on UDP 3629 and relays the answers; only local network
  addresses are then asked. Each projector is identified by its serial number
  (`SNO?`, external id `epson:<serial>`), or by its address when it answers
  none.
- **ESC/VP.net only**: a TCP session to port 3629, the CONNECT handshake
  (with the optional password), then ESC/VP21 (`PWR?`, `SOURCE?`, `CMODE?`,
  `MUTE?`, `LAMP?`). Never the HTTP mode of `epson-projector`, which imitates
  the web remote of the projector. A session is reused while it is used and
  closed after 10 s of silence.
- **Polling** at the configured interval (30 s by default, never faster, a
  reconnection to Gladys included); source, color mode and mute only while
  the projector is on.
- **Commands**: serialized per projector, each within a 3.5 s budget (Gladys
  acks in 5 s), decided on the power state read just before. Power on only
  from standby, Standby only when on; their answer comes after the warm-up or
  cool-down (up to 40 s): when not in the budget, reported "sent, without
  confirmation yet", the queue held until the answer (other commands refused
  at once), the state read again. A/V mute reads the state and sends the
  explicit opposite. Every send is checked against the deadline just before
  it leaves (never sent after "nothing sent"), and the ack never waits for
  the publication of the states. A message that may have reached the
  projector is reported "sent, without confirmation". After an absence the
  serial number is read again before any command or publication.
- **Password**: missing or refused, a block persisted per address in /data,
  tried again every 30 minutes or when the configuration is saved, never in a
  loop. Never logged, never in /data.
- **Features**: read-only `unknown/binary` power state and two `button/push`
  (power on, standby), never a switch; `text/text` status, `text/select`
  source and color mode, `television/volume-mute` A/V mute,
  `duration/integer` lamp hours (unit `hours`).
- **Bounded input**: 512 bytes per ESC/VP21 answer, 16 + 8 × 18 bytes for a
  handshake, linear parsing, a request that timed out closes its session (a
  late answer never settles the next request), identifiers and codes checked
  against strict patterns, the projector table of `/data` without prototype.

## Development

```bash
npm install
npm test                                        # node --test, loopback only (fake projector)
npm run lint && npm run format:check
npm run audit
npm run cover                                   # regenerates cover.png (800×534, no dependency)
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/fixtures/fakeProjector.js` is a fake Epson projector on 127.0.0.1 (the
handshake with an optional password, the ESC/VP21 questions and commands, the
power cycle with delayed answers, busy, silent, junk and pushed IMEVENT
modes). The end-to-end tests run the real handlers against the SDK's fake
Gladys.

## Credits

- [`epson-projector`](https://github.com/pszafer/epson_projector) 0.6.0 by
  Paweł Szafer (MIT), the library behind the Home Assistant Epson
  integration: the ESC/VP.net messages, the ESC/VP21 session, the commands and
  the codes are ported from it to JavaScript (its TCP transport only).
- The app structure follows
  [LM1LC3N7/gladys-panasonic-viera](https://github.com/LM1LC3N7/gladys-panasonic-viera) and
  [LM1LC3N7/gladys-cambridge-audio](https://github.com/LM1LC3N7/gladys-cambridge-audio)
  (same author, Apache-2.0).

Epson is a trademark of its owner, used here only to name the compatible
products.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic is added at the first real release.

## License

Apache-2.0, see [LICENSE](LICENSE). Third-party notices (epson-projector,
MIT): [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
