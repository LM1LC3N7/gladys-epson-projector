// -----------------------------------------------------------------------------
// Known projectors -> Gladys devices and states (pure). One Gladys device per
// projector, keyed by its id (serial number, or the address when the
// projector does not give one): see TODO.md "Decisions".
//
// Categories and types of the Gladys core only: the power state read only
// (`unknown/binary`) and two `button/push` ("Power on", "Standby"), never a
// switch an "everything off" could reach; `text/text` for the status,
// `text/select` for the source and the color mode, `television/volume-mute`
// for the A/V mute press, `duration/integer` in hours (a unit the core lists
// for `duration`) for the lamp.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE, FEATURES } from './constants.js';
import { COLOR_MODES, IDENTITY_LABEL, SOURCES } from './escvp/codes.js';

/** The feature definitions, by frozen key, in their frozen order. */
export const FEATURE_SPECS = Object.freeze({
  [FEATURES.POWER]: {
    name: 'Power',
    category: C.UNKNOWN,
    // 'binary', as the core's other read-only power states.
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    read_only: true,
    keep_history: true,
  },
  [FEATURES.POWER_ON]: {
    name: 'Power on',
    category: C.BUTTON,
    type: T.BUTTON.PUSH,
    min: 0,
    max: 1,
  },
  [FEATURES.STANDBY]: { name: 'Standby', category: C.BUTTON, type: T.BUTTON.PUSH, min: 0, max: 1 },
  [FEATURES.STATUS]: {
    name: 'Status',
    category: C.TEXT,
    type: T.TEXT.TEXT,
    min: 0,
    max: 0,
    read_only: true,
  },
  [FEATURES.SOURCE]: {
    name: 'Source',
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    has_feedback: true,
  },
  [FEATURES.COLOR_MODE]: {
    name: 'Color mode',
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    has_feedback: true,
  },
  [FEATURES.AV_MUTE]: {
    name: 'A/V mute',
    category: C.TELEVISION,
    type: T.TELEVISION.VOLUME_MUTE,
    min: 0,
    max: 1,
    has_feedback: true,
  },
  [FEATURES.LAMP_HOURS]: {
    name: 'Lamp hours',
    category: C.DURATION,
    type: T.DURATION.INTEGER,
    unit: U.HOURS,
    min: 0,
    max: 1_000_000,
    read_only: true,
  },
});

/** Options of a dropdown: the known codes, then the codes seen on this projector. */
function options(known, seen, prefix) {
  const list = known.map(({ value, label }) => ({ value, label }));
  for (const code of seen ?? []) {
    if (!list.some((option) => option.value === code)) {
      list.push({ value: code, label: `${prefix} ${code}` });
    }
  }
  return list;
}

export const sourceOptions = (projector) => options(SOURCES, projector.sources, 'Source');
export const colorModeOptions = (projector) =>
  options(COLOR_MODES, projector.colorModes, 'Color mode');

export function projectorName(projector) {
  return projector.name || `Epson projector ${projector.host || projector.id}`;
}

export function buildDevice(gladys, projector) {
  const ids = gladys.externalIds(DEVICE_TYPE, projector.id);
  return {
    name: projectorName(projector),
    external_id: ids.device,
    should_poll: false,
    params: [{ name: 'IP_ADDRESS', value: projector.host || '' }],
    // Always the full, fixed list: a device published again never loses a feature.
    features: Object.entries(FEATURE_SPECS).map(([key, { name, ...spec }]) => ({
      name,
      external_id: ids.feature(key),
      read_only: false,
      has_feedback: false,
      keep_history: false,
      ...spec,
      ...(key === FEATURES.SOURCE ? { supported_options: sourceOptions(projector) } : {}),
      ...(key === FEATURES.COLOR_MODE ? { supported_options: colorModeOptions(projector) } : {}),
    })),
  };
}

/** The feature key of a feature external id of `device`, or undefined. */
export function featureKey(deviceExternalId, featureExternalId) {
  const prefix = `${deviceExternalId}:`;
  return String(featureExternalId ?? '').startsWith(prefix)
    ? String(featureExternalId).slice(prefix.length)
    : undefined;
}

/**
 * The states of a reading:
 *   undefined                      nothing known: nothing published
 *   { reachable: false }           no connection: power 0, status "Unreachable"
 *   { reachable: true, power, source?, colorMode?, muted?, lampHours? }
 * Only the values actually read are published.
 */
export function stateList(gladys, projector, reading, unreachableLabel) {
  if (!reading) {
    return [];
  }
  const ids = gladys.externalIds(DEVICE_TYPE, projector.id);
  const id = (key) => ids.feature(key);
  if (reading.reachable === false) {
    return [
      { device_feature_external_id: id(FEATURES.POWER), state: 0 },
      { device_feature_external_id: id(FEATURES.STATUS), text: unreachableLabel },
    ];
  }
  if (reading.identityUnconfirmed) {
    // Maybe another projector at this address: only the status says so.
    return [{ device_feature_external_id: id(FEATURES.STATUS), text: IDENTITY_LABEL }];
  }
  const states = [];
  if (reading.power) {
    if (typeof reading.power.on === 'boolean') {
      states.push({
        device_feature_external_id: id(FEATURES.POWER),
        state: reading.power.on ? 1 : 0,
      });
    }
    states.push({ device_feature_external_id: id(FEATURES.STATUS), text: reading.power.label });
  }
  if (reading.source && sourceOptions(projector).some((o) => o.value === reading.source)) {
    states.push({ device_feature_external_id: id(FEATURES.SOURCE), text: reading.source });
  }
  if (reading.colorMode && colorModeOptions(projector).some((o) => o.value === reading.colorMode)) {
    states.push({ device_feature_external_id: id(FEATURES.COLOR_MODE), text: reading.colorMode });
  }
  if (typeof reading.muted === 'boolean') {
    states.push({ device_feature_external_id: id(FEATURES.AV_MUTE), state: reading.muted ? 1 : 0 });
  }
  if (Number.isInteger(reading.lampHours)) {
    states.push({ device_feature_external_id: id(FEATURES.LAMP_HOURS), state: reading.lampHours });
  }
  return states;
}
