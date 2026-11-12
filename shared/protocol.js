// Wire contract between server and client. Every message is a JSON object with a `t` field.

export const MAX_SEATS = 6;
export const NAME_MAX = 16;
export const TURN_SECONDS_OPTIONS = [15, 30, 45, 60];
export const CODE_LENGTH = 4;
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Sent as the WebSocket close code when another tab resumes the same seat; the old tab must not reconnect.
export const WS_CLOSE_REPLACED = 4001;

export const C2S = {
  CREATE: 'create',
  JOIN: 'join',
  RESUME: 'resume',
  START: 'start',
  ACTION: 'action',
  CLOSE: 'close',
  LEAVE: 'leave',
  BACK: 'back',
};

export const S2C = {
  WELCOME: 'welcome',
  ERROR: 'error',
  UPDATE: 'update',
  CLOSED: 'closed',
};

export const EV = {
  HAND_START: 'handStart',
  BLIND: 'blind',
  DEAL: 'deal',
  TURN: 'turn',
  ACTION: 'action',
  REFUND: 'refund',
  COLLECT: 'collect',
  REVEAL: 'reveal',
  BOARD: 'board',
  SHOWDOWN: 'showdown',
  WIN: 'win',
  BUST: 'bust',
  HAND_END: 'handEnd',
};

export const ERR = {
  BAD_MESSAGE: 'bad_message',
  BAD_CONFIG: 'bad_config',
  BAD_NAME: 'bad_name',
  NO_ROOM: 'no_room',
  ROOM_FULL: 'room_full',
  ROOM_CLOSED: 'room_closed',
  BAD_TOKEN: 'bad_token',
  NOT_HOST: 'not_host',
  CANNOT_START: 'cannot_start',
  ILLEGAL_ACTION: 'illegal_action',
  STALE_ACTION: 'stale_action',
  RATE_LIMIT: 'rate_limit',
};

/**
 * Returns an error string, or null when the config is valid.
 * @param {RoomConfig} c
 */
export function validateConfig(c) {
  if (!c || typeof c !== 'object') return 'Missing config';
  const ints = [c.buyIn, c.smallBlind, c.bigBlind];
  if (!ints.every((n) => Number.isInteger(n) && n > 0)) return 'Buy-in and blinds must be positive whole numbers';
  if (c.smallBlind > c.bigBlind) return 'Small blind cannot exceed big blind';
  if (c.buyIn < c.bigBlind * 10) return 'Buy-in must be at least 10 big blinds';
  if (c.buyIn > 10_000_000) return 'Buy-in is too large';
  if (!TURN_SECONDS_OPTIONS.includes(c.turnSeconds)) return 'Invalid turn timer';
  return null;
}

/**
 * @typedef {string} Card  two chars, rank + suit: "As", "Td", "2c" (see shared/cards.js)
 *
 * @typedef {Object} RoomConfig
 * @property {number} buyIn
 * @property {number} smallBlind
 * @property {number} bigBlind
 * @property {number} turnSeconds  one of TURN_SECONDS_OPTIONS
 *
 * ---------- client -> server ----------
 * @typedef {{t:'create', name:string, config:RoomConfig}} CreateMsg
 * @typedef {{t:'join', code:string, name:string}} JoinMsg
 * @typedef {{t:'resume', code:string, token:string}} ResumeMsg
 * @typedef {{t:'start'}} StartMsg                                   host only; deals the first and every later hand
 * @typedef {{t:'action', handId:number, turnId:number, type:'fold'|'check'|'call'|'raiseTo', amount?:number}} ActionMsg
 *   `amount` is only for raiseTo and is the player's TOTAL bet for this street (a "raise to"), which also
 *   covers an opening bet. Going all-in is raiseTo with amount = legal.raise.max, or call when short.
 * @typedef {{t:'close'}} CloseMsg                                   host only
 * @typedef {{t:'leave'}} LeaveMsg   before the first hand the seat is freed; afterwards the player keeps
 *   their chips and is auto-checked/folded like a disconnected player
 * @typedef {{t:'back'}} BackMsg     clears the sender's away state (set after two missed turns in a row)
 *
 * ---------- server -> client ----------
 * @typedef {{t:'welcome', playerId:string, token:string, code:string, seat:number}} WelcomeMsg
 * @typedef {{t:'error', code:string, message:string}} ErrorMsg
 * @typedef {{t:'update', seq:number, events:GameEvent[], state:View}} UpdateMsg
 *   Events say what to animate, in order; `state` is the truth once they have all played.
 *   Lobby changes and reconnects send events: [].
 * @typedef {{t:'closed', scoreboard:ScoreRow[]}} ClosedMsg
 * @typedef {{name:string, stack:number, net:number, handsWon:number}} ScoreRow   sorted by stack desc
 *
 * ---------- events (seat = absolute seat index 0..5) ----------
 * @typedef {{e:'handStart', handId:number, button:number, sbSeat:number, bbSeat:number, seats:number[]}} HandStartEv
 *   seats = seats dealt into this hand
 * @typedef {{e:'blind', seat:number, amount:number, kind:'small'|'big'}} BlindEv
 * @typedef {{e:'deal', order:number[], cards:Object<number,[Card,Card]>}} DealEv
 *   order = seats in dealing order (one card each, twice round). On the wire `cards` holds only the
 *   recipient's own seat (or is empty for spectators).
 * @typedef {{e:'turn', seat:number, turnId:number}} TurnEv
 * @typedef {{e:'action', seat:number, kind:'fold'|'check'|'call'|'bet'|'raise', added:number, to:number, allIn:boolean}} ActionEv
 *   added = chips moved from stack this action; to = the seat's total street bet afterwards
 * @typedef {{e:'refund', seat:number, amount:number}} RefundEv       uncalled bet returned
 * @typedef {{e:'collect', pots:{amount:number}[]}} CollectEv         street bets swept into the pot(s); pots = totals after
 * @typedef {{e:'reveal', hands:{seat:number, cards:[Card,Card]}[]}} RevealEv   all-in runout: hands turned face up
 * @typedef {{e:'board', street:'flop'|'turn'|'river', cards:Card[]}} BoardEv   only the newly dealt cards
 * @typedef {{e:'showdown', hands:{seat:number, cards:[Card,Card], name:string, best5:Card[]}[]}} ShowdownEv
 *   name = human description, e.g. "Full House, Kings over Tens"
 * @typedef {{e:'win', potIndex:number, amount:number, winners:{seat:number, amount:number}[], uncontested:boolean}} WinEv
 * @typedef {{e:'bust', seat:number}} BustEv
 * @typedef {{e:'handEnd', stacks:Object<number,number>}} HandEndEv
 * @typedef {HandStartEv|BlindEv|DealEv|TurnEv|ActionEv|RefundEv|CollectEv|RevealEv|BoardEv|ShowdownEv|WinEv|BustEv|HandEndEv} GameEvent
 *
 * ---------- per-player view ----------
 * @typedef {Object} View
 * @property {{code:string, status:'lobby'|'playing'|'closed', hostId:string, config:RoomConfig,
 *             share:{lan:string[], tunnel:string|null}}} room
 *   status 'lobby' = no hand running (before the first hand, or fewer than 2 players have chips)
 * @property {(null|SeatView)[]} seats   length MAX_SEATS, indexed by seat
 * @property {null|HandView} hand
 * @property {{playerId:string, seat:number, isHost:boolean, legal:null|Legal}} you
 *
 * @typedef {{seat:number, name:string, stack:number, busted:boolean, connected:boolean, away:boolean, isHost:boolean}} SeatView
 *
 * @typedef {Object} HandView
 * @property {number} handId
 * @property {'preflop'|'flop'|'turn'|'river'|'complete'} phase
 * @property {number} button
 * @property {number} sbSeat
 * @property {number} bbSeat
 * @property {Card[]} board
 * @property {{amount:number}[]} pots     chips already collected from finished streets
 * @property {number} potTotal            pots + all current street bets
 * @property {number} currentBet
 * @property {null|number} toAct          seat whose turn it is
 * @property {number} turnId
 * @property {number} remainingMs         time left before toAct is auto-acted (0 when nobody is to act);
 *                                        may exceed turnMs while the preceding animations play
 * @property {number} turnMs              the player's full clock for this turn, for drawing the timer ring
 * @property {Object<number,{folded:boolean, allIn:boolean, streetBet:number, committed:number, cards:null|[Card,Card]}>} players
 *   keyed by seat, only seats dealt into the hand. committed = chips put in over the whole hand. cards is null unless it is the viewer's own hand or
 *   the hand has been revealed.
 *
 * @typedef {{check:boolean, call:number, raise:null|{min:number, max:number}}} Legal
 *   Present only when it is the viewer's turn. Fold is always allowed. call = chips to add (0 when check
 *   is true). raise.min/max are raise-to totals for the street; max is all-in.
 */
