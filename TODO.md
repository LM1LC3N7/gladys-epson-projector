# TODO — Epson Projector v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only.

## Status

- [x] **Milestone 1 — local control** (2026-10-20): projectors added by IP
      address or found by the ESC/VP.net HELLO broadcast through Gladys
      (`scanNetwork('udp-active-broadcast')`, optional), identity by serial
      number (or address); ESC/VP.net sessions on TCP 3629 with the optional
      password; power state, status, power on, standby, source, color mode,
      A/V mute, lamp hours; persisted password blocks; "Find" and "Check"
      buttons; docs en/fr. Tested against a fake projector on the loopback
      interface only, never with a real device. The store validator could not
      be run from the development session (no access to it there): to run
      before the first release.
- [ ] **Milestone 2 — real projectors** (testers with an EH-TW, EH-LS or EB
      model). To check first:
  - that `SNO?` answers over ESC/VP.net (epson-projector reads the serial
    number through the undocumented EasyMP protocol on port 3620 instead,
    which is not ported), and in standby;
  - whether the HELLO answer comes back to the port the core sends from (the
    library listens on 3629 itself);
  - the answer times of `PWR ON` / `PWR OFF` (today: acked when sent if not
    answered within the budget, the answer waited 40 s / 10 s);
  - the `LAMP?` answer of laser models, the `SOURCE?` / `CMODE?` codes of
    recent models, `MUTE?` in standby;
  - whether the projector closes an idle session by itself, and how many
    sessions it accepts at once;
  - the rendering on the Gladys dashboard (not checked here): the two
    `button/push`, the `unknown/binary` power, the `text/text` status, the
    `text/select` dropdowns, the `television/volume-mute` press, the
    `duration/integer` lamp hours.
- [ ] **Milestone 3 — more**: volume (capped by an option, as the audio
      modules), freeze, lens memories (`POPLP`), image memories (`POPMEM`),
      the error code (`ERR?`) as a sensor, the IMEVENT pushes (warnings,
      alarms), one password per projector, a "forget a projector" action.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, then the store validator once the image is published.

## Decisions

- Forum: no dedicated topic, no post from this module's work; one recap per
  wave in /t/10385, posted by the main session.
- Reuse: pszafer/epson_projector 0.6.0 (MIT, PyPI 2025-10-16, repository read
  at `85871d5` of 2026-06-23, the library of the Home Assistant Epson
  integration) is Python (asyncio), so its ESC/VP.net messages, ESC/VP21
  session, commands and codes are ported to JavaScript (`src/escvp/`); MIT
  notice in `THIRD_PARTY_NOTICES.md`, copied into the image. Its LICENSE file
  is the MIT text with the copyright line of a packaging template ("The
  Python Packaging Authority"): reproduced as is.
- **ESC/VP.net only** (TCP 3629, published by Epson). The HTTP mode of the
  library (`/cgi-bin/json_query`, `directsend`, the `EPSONWEB` login), which
  imitates the web remote of the projector, is not ported; neither is the
  serial port mode, nor the EasyMP serial number protocol (port 3620,
  undocumented). No runtime dependency besides the SDK.
- Version 0.1.0 in `package.json`, `package-lock.json`, the manifest and the
  `docker_image` tag, set by hand at milestone 1: the one exception to
  "versions belong to the Release workflow", because the template's 1.0.0 and
  its image were someone else's. The first patch release gives 0.1.1.
- External ids: `gladys.externalIds('epson', <id>)`, `<id>` the serial number
  read with `SNO?` (4 to 32 letters or digits, upper case) at the first
  contact, else `ip-<address>` (dots as dashes, `-<port>` when not 3629).
  Never changed afterwards (no migration from an address id to a serial id:
  it would orphan the history). A projector keyed by its serial and found
  again at its address after being unreachable has its serial checked: another
  serial there clears its address (DHCP), never commanded there. Feature keys
  are frozen: `power`, `power_on`, `standby`, `status`, `source`,
  `color_mode`, `av_mute`, `lamp_hours`. Every publication carries the full,
  fixed feature list; only the dropdown options grow (codes read on the
  projector, merged with the `supported_options` of the created device).
- **Power: read-only state + two `button/push` ("Power on", "Standby"), not a
  `switch`** (lesson of lot 6: an "everything on / off" must not command a
  projector). Power is 1 for `01` (on) and `02` (warming up), 0 for `00`,
  `03`, `04`, `05`, `09` and when nothing answers; an unknown code shows in
  the status and publishes no power. Power on is sent only from `00`, `04`,
  `09`; refused, "nothing sent", while cooling down (`03`) or in abnormal
  standby (`05`). Standby is sent only from `01` (already in standby: nothing
  to do; warming up: refused, "nothing sent").
- Power command answers: the projector answers `:` once the warm-up or
  cool-down is over (epson-projector waits 40 s for `PWR ON`, 10 s for
  `PWR OFF`). Answered within the command budget: done. Otherwise the command
  is acked to Gladys as sent (it left, and the state read just before allowed
  it), the answer waited for in the background on the same session, the queue
  of the projector held until then (the commands behind it are dropped at
  their deadline, "nothing sent"; the polling skips the projector), then the
  state is read again. ERR is reported "Refused by the projector".
- Commands: serialized per projector (Standby before the commands still
  waiting, never before the one running), budget 3.5 s from the Gladys
  request (queue included), the power state read first within 1.5 s; a
  command still queued at its deadline is dropped, never sent late. A
  command that may have left is answered "sent, without confirmation", one
  that could not leave "nothing sent". Values checked before anything is
  queued: a source or color mode must be a two-digit hexadecimal code listed
  in the dropdown (no CR or space can reach the projector); commands are
  written only when they match a strict pattern.
- Source, color mode and A/V mute: only while the power state is `01`, as the
  projector answers ERR otherwise. A/V mute is a press: `MUTE?` read just
  before, the explicit `MUTE ON|OFF` sent, never a toggle.
- Polling: every created projector at the configured interval (10 to 600 s,
  30 by default), never faster (a reconnection to Gladys republishes the last
  reading without asking the projector); `LAMP?` always, `SOURCE?`, `CMODE?`,
  `MUTE?` only when on; a question the model refuses (ERR) is left out.
- Reachability: no TCP connection = "Unreachable": power 0, named in the
  status. A connection without handshake, a busy projector or an unexpected
  answer publishes nothing (logged once). The status stays "connected" (local
  integration, no account), except while a password blocks a projector.
- Password (one for all projectors, 16 ASCII characters at most, config
  `secret`): sent only in the CONNECT header. ESC/VP.net status 0x41
  (required) or 0x43 (refused) becomes a block per `host:port`, persisted in
  /data with the time of the next try (30 minutes later; read back capped to
  30 minutes from the start). While blocked, nothing is sent to that address:
  no polling, no command ("password missing or refused, nothing sent"), no
  identification. Saving the configuration lifts every block (an explicit
  user action); a reconnection to Gladys and a restart lift nothing. Never
  logged, never in /data, never in a message.
- Sessions: one per projector at a time, reused while used, closed after
  10 s of silence (never under a power command waiting for its answer). A
  request that timed out closes its session (a late answer never settles the
  next request); an answer for another command closes it too. Pushed IMEVENT
  messages are skipped (not used yet).
- Search: `udp-active-broadcast` on port 3629 with the HELLO request (16
  bytes); only the IPv4 addresses of a local network that answered with a
  valid HELLO are asked (10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16
  but 169.254.169.254; no .0 nor .255), 50 replies at most; the projector
  name of the HELLO answer names the device. Typed addresses are not
  filtered. A typed address where nothing answers is asked again every
  minute.
- Hostile input: an ESC/VP21 frame is 512 bytes at most, a handshake 16 + 8 ×
  18 bytes; parsing is linear (no backtracking regex on unbounded input);
  commands, codes, serials and ids match strict patterns; the projector and
  block tables of /data have no prototype; names are cleaned of control
  characters and cut to 64 characters.
- Categories and types from the core only (`server/utils/constants.js`):
  `unknown/binary`, `button/push`, `text/text`, `text/select`,
  `television/volume-mute`, `duration/integer` with the unit `hours` (listed
  by `DEVICE_FEATURE_UNITS_BY_CATEGORY` for `duration`). Store category
  `multimedia`.
