import { randomInt } from 'node:crypto';
import { CODE_ALPHABET, CODE_LENGTH, ERR, NAME_MAX, validateConfig } from '../shared/protocol.js';
import { Room, RoomError, normalizeName } from './room.js';

// Closed rooms linger so a late join/resume gets ROOM_CLOSED instead of NO_ROOM.
const CLOSED_ROOM_TTL_MS = 60 * 60 * 1000;

export class RoomManager {
  constructor({ share = { lan: [], tunnel: null }, roomOptions = {} } = {}) {
    this.share = share;
    this.roomOptions = roomOptions;
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
  }

  /** @returns {{room: Room, player: object}} */
  create(name, config, socket = null) {
    if (!normalizeName(name)) throw new RoomError(ERR.BAD_NAME, `Enter a name of 1 to ${NAME_MAX} characters`);
    const problem = validateConfig(config);
    if (problem) throw new RoomError(ERR.BAD_CONFIG, problem);
    this.#pruneClosed();
    const code = this.#newCode();
    const room = new Room({
      ...this.roomOptions,
      code,
      config,
      share: this.share,
      onEmpty: () => this.remove(code),
    });
    this.rooms.set(code, room);
    const player = room.join(name, socket);
    return { room, player };
  }

  get(code) {
    if (typeof code !== 'string') return undefined;
    return this.rooms.get(code.trim().toUpperCase());
  }

  remove(code) {
    const room = this.get(code);
    if (!room) return;
    room.forceClose();
    this.rooms.delete(room.code);
  }

  closeAll() {
    for (const room of this.rooms.values()) room.forceClose();
    this.rooms.clear();
  }

  #newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  #pruneClosed() {
    for (const [code, room] of this.rooms) {
      if (room.closed && room.now() - room.closedAt > CLOSED_ROOM_TTL_MS) this.rooms.delete(code);
    }
  }
}
