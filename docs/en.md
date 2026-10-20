# Epson projectors for Gladys

Control your **Epson projectors** (home cinema EH-TW / EH-LS, business EB…)
from Gladys, locally, without any cloud: power on, standby, source, color
mode, A/V mute, and the lamp (or light source) hours.

> **Important.** This integration has never been tested with a real device:
> it was written from the `epson-projector` library (the one Home Assistant
> uses) and the protocol Epson publishes, and tested against a fake projector
> only. Your feedback is welcome.
> Unofficial integration, not affiliated with Epson.

## Setup

1. On the projector, enable the **network standby**: depending on the model,
   _Settings_ or _ECO_ > **Standby Mode: Communication On** (or _Network
   Standby_). Without it, the projector leaves the network in standby and
   cannot be turned on from Gladys.
2. Give each projector a **fixed IP address** in your router (reserved DHCP
   lease).
3. In Gladys, install the **Epson Projector** integration, then open its
   configuration.
4. Type the IP addresses, separated by commas (for example
   `192.168.1.50, 192.168.1.51`). The **Find the projectors** button can also
   look for them on the network (optional: the search cannot cross every
   network).
5. If a password protects the network control of your projectors, type it
   (16 characters at most, the same for all of them).
6. The projectors appear in the **Discovery** tab: create them.

The integration talks to the projector with **ESC/VP.net** (TCP port 3629),
the network control protocol Epson publishes, and reads its state at the
refresh interval of the configuration (30 s by default). It does not use the
web remote of the projector.

## What you get

| Feature    | Gladys type              | Note                                                        |
| ---------- | ------------------------ | ----------------------------------------------------------- |
| Power      | binary state (read only) | 1 on or warming up, 0 in standby, cooling down, unreachable |
| Power on   | button                   | sent only from standby                                      |
| Standby    | button                   | sent only when on                                           |
| Status     | text (read only)         | Standby, Warming up, On, Cooling down, Abnormal standby…    |
| Source     | dropdown                 | HDMI1, HDMI2, Computer, Video, USB, LAN, Screen mirroring…  |
| Color mode | dropdown                 | Cinema, Natural, Dynamic, Bright Cinema, Game…              |
| A/V mute   | button (mute)            | each press reads the state, then sets the opposite          |
| Lamp hours | duration in hours        | the light source hours on laser models                      |

On purpose, no **switch**: an "everything off" or "everything on" from a
voice assistant or a scene neither turns your projector on nor cuts it.

Source, color mode and A/V mute are only read and set while the projector is
on. Which sources and color modes a projector offers depends on its model: a
value the model refuses is reported "refused by the projector". A source or a
color mode the projector shows that the list does not know yet is added to
the dropdown by itself (use "Update" in Gladys to see it).

## Commands

Every command first reads the power state of the projector, and is decided on
it:

- **Power on** is sent only from standby; already on or warming up, nothing is
  sent. While the projector cools down (or in abnormal standby), nothing is
  sent and the reason is given.
- **Standby** is sent only when the projector is on.
- The projector confirms a power command only once its warm-up or cool-down is
  over (up to 40 s): Gladys gets the answer as soon as the command is sent,
  and the state is read again once the projector confirms. Meanwhile, the
  other commands to that projector are refused, "nothing sent".

Every command is answered within 4 seconds (Gladys waits 5 seconds). A
command that left for the projector without confirmation is reported "sent,
without confirmation"; one that could not leave is reported "nothing sent".

## Password

ESC/VP.net can be protected by a password on the projector. A password
missing or refused stops the integration for that projector (the integration
status says so): it is tried again every 30 minutes, or as soon as you save
the configuration, never in a loop. The password is kept by Gladys in its
database, never shown again, sent only to your projectors over your local
network (ESC/VP.net sends it as plain text), and never written in the logs
nor in the data folder of the integration.

## Configuration buttons

- **Find the projectors**: a HELLO broadcast on the network through Gladys
  (UDP port 3629), then the typed addresses.
- **Check the projectors**: the state and the lamp hours of each projector.

## Data and privacy

The integration keeps in `/data/epson-projector.json` the list of the known
projectors (id, address, name, codes seen) and the password blocks (address
and time of the next try, never the password). Nothing leaves your local
network.

## Known limits

- One password for all the projectors.
- A projector that gives no serial number is identified by its address: if
  its address changes, it becomes a new device.
- No lens, keystone, volume, freeze or picture settings yet.
- Never tested with a real device: the real answers may differ.
