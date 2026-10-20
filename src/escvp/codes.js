// -----------------------------------------------------------------------------
// ESC/VP21 commands and values used by the integration (pure). The source and
// color mode codes are the ones of epson-projector (pszafer, MIT, `const.py`:
// SOURCE_LIST, CMODE_LIST); the power codes are those of the ESC/VP21 command
// guide Epson publishes. Which codes a projector accepts depends on its model:
// the projector answers ERR to the others.
// -----------------------------------------------------------------------------

export const COMMANDS = Object.freeze({
  POWER: 'PWR',
  SOURCE: 'SOURCE',
  COLOR_MODE: 'CMODE',
  MUTE: 'MUTE',
  LAMP: 'LAMP',
  SERIAL: 'SNO',
});

/**
 * `PWR?` answers. `on` is the power shown in Gladys; `canPowerOn` and
 * `inStandby` decide the buttons.
 */
export const POWER_STATES = Object.freeze({
  '00': { label: 'Standby', on: false, inStandby: true, canPowerOn: true },
  '01': { label: 'On', on: true, inStandby: false, canPowerOn: false },
  '02': { label: 'Warming up', on: true, inStandby: false, canPowerOn: false },
  '03': { label: 'Cooling down', on: false, inStandby: true, canPowerOn: false },
  '04': { label: 'Standby', on: false, inStandby: true, canPowerOn: true },
  '05': { label: 'Abnormal standby', on: false, inStandby: true, canPowerOn: false },
  '09': { label: 'A/V standby', on: false, inStandby: true, canPowerOn: true },
});

/** Shown when the projector does not answer at all. */
export const UNREACHABLE_LABEL = 'Unreachable';

/**
 * `PWR?` answer -> its entry. A code not listed is shown as is, its power
 * unknown (never published, no button acts on it); not a code: undefined.
 */
export function powerState(value) {
  const code = parseCode(value);
  if (!code) {
    return undefined;
  }
  if (Object.hasOwn(POWER_STATES, code)) {
    return { code, ...POWER_STATES[code] };
  }
  return { code, label: `Unknown (${code})`, on: undefined, inStandby: false, canPowerOn: false };
}

/** Source codes (`SOURCE xx`), with their labels. */
export const SOURCES = Object.freeze([
  { value: '30', label: 'HDMI1' },
  { value: 'A0', label: 'HDMI2' },
  { value: '10', label: 'Computer' },
  { value: '40', label: 'Video' },
  { value: '41', label: 'Video (RCA)' },
  { value: '52', label: 'USB' },
  { value: '53', label: 'LAN' },
  { value: '56', label: 'Screen mirroring' },
]);

/** Color mode codes (`CMODE xx`), with their labels. */
export const COLOR_MODES = Object.freeze([
  { value: '00', label: 'Auto' },
  { value: '15', label: 'Cinema' },
  { value: '07', label: 'Natural' },
  { value: '0C', label: 'Bright Cinema' },
  { value: '06', label: 'Dynamic' },
  { value: '17', label: '3D Cinema' },
  { value: '18', label: '3D Dynamic' },
  { value: '19', label: '3D THX' },
  { value: '20', label: 'B&W Cinema' },
  { value: '21', label: 'Adobe RGB' },
  { value: '22', label: 'Digital Cinema' },
  { value: '13', label: 'THX' },
  { value: '0D', label: 'Game' },
  { value: '16', label: 'Stage' },
  { value: 'C1', label: 'AutoColor' },
  { value: '0B', label: 'x.v. color' },
  { value: '05', label: 'Theatre' },
  { value: '09', label: 'Theatre Black 1/HD' },
  { value: '0A', label: 'Theatre Black 2/Silver Screen' },
]);

/**
 * A source or color mode code as the projector writes it: two hexadecimal
 * digits, upper case. Anything else is not a code (never sent, never kept).
 */
export function parseCode(value) {
  const text = String(value ?? '')
    .trim()
    .toUpperCase();
  return /^[0-9A-F]{2}$/.test(text) ? text : undefined;
}

/** `MUTE?` answer -> true, false or undefined. */
export function parseMute(value) {
  const text = String(value ?? '')
    .trim()
    .toUpperCase();
  if (text === 'ON') {
    return true;
  }
  if (text === 'OFF') {
    return false;
  }
  return undefined;
}

/**
 * `LAMP?` answer -> hours (the first number: some models add a second one),
 * or undefined. Laser models answer the light source hours.
 */
export function parseLampHours(value) {
  const match = /^(\d{1,7})(?:\s|$)/.exec(String(value ?? '').trim());
  if (!match) {
    return undefined;
  }
  const hours = Number(match[1]);
  return hours <= 1_000_000 ? hours : undefined;
}

/** `SNO?` answer -> a serial number usable in an external id, or undefined. */
export function parseSerial(value) {
  const text = String(value ?? '').trim();
  return /^[A-Za-z0-9]{4,32}$/.test(text) ? text.toUpperCase() : undefined;
}
