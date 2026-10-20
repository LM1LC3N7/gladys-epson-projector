// -----------------------------------------------------------------------------
// Frozen keys (external ids, features, manifest actions), limits and timings.
// Every key here is stored by Gladys or by its users: never rename one.
// -----------------------------------------------------------------------------

/** `gladys.externalIds(DEVICE_TYPE, <projector id>)`. */
export const DEVICE_TYPE = 'epson';

export const FEATURES = Object.freeze({
  POWER: 'power',
  POWER_ON: 'power_on',
  STANDBY: 'standby',
  STATUS: 'status',
  SOURCE: 'source',
  COLOR_MODE: 'color_mode',
  AV_MUTE: 'av_mute',
  LAMP_HOURS: 'lamp_hours',
});

export const ACTIONS = Object.freeze({
  FIND: 'find_projectors',
  CHECK: 'check_projectors',
});

export const POLL_INTERVAL = Object.freeze({ min: 10, max: 600, default: 30 });

export const TIMINGS = Object.freeze({
  /** TCP connection and ESC/VP.net handshake. */
  connectTimeout: 3_000,
  /** One ESC/VP21 question (the timeout of epson-projector is 3 s). */
  requestTimeout: 3_000,
  /**
   * A whole reading (connection and up to six questions): bounded so that a
   * slow projector never holds its queue long before a Standby.
   */
  readBudget: 6_000,
  /** A command is sent only with at least this much of its budget left. */
  minSendTime: 300,
  /** A session unused this long is closed. */
  idleClose: 10_000,
  /**
   * A Gladys command is acked within 5 s: the state read before it gets
   * `preRead`, the whole command (queue and read included) `commandBudget`.
   */
  preRead: 1_500,
  commandBudget: 3_500,
  /**
   * The projector answers a power command once warm-up or cool-down is over
   * (epson-projector waits 40 s for PWR ON, 10 s for PWR OFF): not answered
   * in the budget, Gladys gets "sent, without confirmation yet", the answer
   * is waited for in the background, the queue of the projector held
   * meanwhile (other commands refused at once).
   */
  powerOnWait: 40_000,
  powerOffWait: 10_000,
  /** After a command, the state is read again this much later. */
  recheckDelay: 2_000,
  /** A typed address where nothing answered is asked again after this. */
  probeRetry: 60_000,
  /** A refused password is tried again after this (never in a loop). */
  authRetry: 30 * 60_000,
  /** Writes to /data are grouped. */
  persistDelay: 1_000,
  /** Listening time of the HELLO search. */
  scanSeconds: 3,
  /**
   * "Find the projectors" has 60 s: the answers are identified 4 at a time,
   * none started after `scanDeadline` (the rest is skipped and said so).
   */
  scanConcurrency: 4,
  scanDeadline: 35_000,
  /** Projectors asked at once by "Check the projectors". */
  checkConcurrency: 4,
});

export const LIMITS = Object.freeze({
  projectors: 20,
  addresses: 20,
  /** Codes seen on a projector and added to a dropdown. */
  extraOptions: 20,
  searchReplies: 50,
  name: 64,
});
