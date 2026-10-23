# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.2] - 2026-10-23

## [0.1.1] - 2026-10-21

### Added

- Epson projectors over ESC/VP.net (TCP port 3629, the protocol Epson
  publishes), without any cloud: added by IP address, or found with an
  optional HELLO search through Gladys, and kept by their serial number when
  their address changes.
- Power state (read only), "Power on" and "Standby" buttons (no switch),
  status text, "Source" and "Color mode" dropdowns read and set, A/V mute
  (each press reads the state and sets the opposite), lamp hours.
- Every command is decided on the power state read just before, and answered
  to Gladys within 4 seconds: "nothing sent" or "sent, without confirmation",
  exactly. A command answered "nothing sent" never leaves afterwards, and the
  answer never waits for Gladys to record the states. A power command not
  confirmed in time is reported "sent, without confirmation yet", the state
  read again once the projector confirms after the warm-up or cool-down;
  meanwhile other commands to it are refused at once.
- After an absence, the serial number is checked again before a command or a
  publication: another projector at the address is never taken for yours. A
  projector in standby that gives no serial number is still shown and can be
  turned on (checked again once on); one that is on without a serial number
  shows "Identity not confirmed" and receives nothing.
- "Check the projectors" and device updates never ask a projector sooner than
  the refresh interval; the search answers within its 60 s, even with many
  silent answers.
- Optional network control password: a missing or refused password is
  persisted, tried again every 30 minutes or when the configuration is saved,
  never in a loop, and named in the integration status.
- "Find the projectors" and "Check the projectors" buttons.

### Security

- Answers are bounded (512 bytes per frame, the handshake to its 8 headers),
  parsed linearly, and a request that timed out closes its session. The
  search only asks local network addresses (not CGNAT 100.64/10). The password is never logged nor
  written to /data.

[Unreleased]: https://github.com/LM1LC3N7/gladys-epson-projector/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LM1LC3N7/gladys-epson-projector/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-epson-projector/releases/tag/v0.1.1
