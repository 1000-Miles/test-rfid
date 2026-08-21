export type Mode = 'manual' | 'ir' | 'hw';

/**
 * How the passage detector decides direction. 'ir' = observed from the two IR
 * beams (the production setup). 'toggle' = the NO-IR trial: antennas face each
 * other, every read burst is a passage, and direction is inferred from state
 * (first pass = received/IN, next pass = ship/OUT).
 */
export type DetectMode = 'ir' | 'toggle';

/** The no-IR trial's knobs, as reported by GET /nexus/summary. */
export interface NexusConfig {
  dedupMs: number;
  quietMs: number;
  maxWindowMs: number;
  detectMode: DetectMode;
  toggleDedupMs: number;
  absenceMs: number;
  minRssi: number | null;
  toggleMinReads: number;
}

export interface GpiState {
  gpi1: boolean | null;
  gpi2: boolean | null;
  raw: string;
}

export interface UdpState {
  listening: boolean;
  port: number;
  frames: number;
  destIp: string | null;
}

export interface Status {
  connected: boolean;
  reading: boolean;
  mode: Mode;
  irDurationMs: number;
  irMinGapMs: number;
  gpi: GpiState;
  udp?: UdpState;
}

export interface TagMsg {
  type: 'tag';
  epc: string;
  antenna: number | null;
  rssi: number | null;
  tid: string | null;
  timestamp: string;
}

export interface GpiMsg extends GpiState {
  type: 'gpi';
  timestamp: string;
}

export interface TriggerMsg {
  type: 'trigger';
  input: number;
  timestamp: string;
}

export interface StatusMsg extends Status {
  type: 'status';
  timestamp: string;
}

export interface LogMsg {
  type: 'log';
  level: string;
  text: string;
  timestamp: string;
}

export interface UdpMsg {
  type: 'udp';
  raw: string;
  len: number;
  from: string;
  parsed: boolean;
  epc: string | null;
  timestamp: string;
}

export interface NexusItem {
  /** Which registry resolved this tag. Absent on unknown tags and on catalog
   *  entries cached before the pallet lookup existed. */
  kind?: 'carton' | 'pallet';
  sku: string;
  name: string;
  pallet: string | null;
  category: string | null;
  /**
   * Carton state from `warehouse_carton` — whether the carton behind this tag is
   * actually in the building. Absent on pallets, on unknown tags, and on any
   * carton with no warehouse row at all (printed but never received).
   */
  state?: string | null;
  receivedAt?: string | null;
  /** The warehouse carton code this tag currently belongs to. Tags are reused. */
  carton?: string | null;
}

/**
 * Why an outbound passage contradicts Nexus's record of the carton. Decided by
 * the bridge (passage.js `_outboundCheck`), null on every ordinary passage.
 */
export type OutboundFault = 'not-received' | 'already-shipped';

export interface EntryMsg {
  type: 'entry' | 'exit';
  direction: 'in' | 'out';
  /** 'ir' = direction observed by the beams; 'toggle' = inferred (no-IR trial). */
  method: 'ir' | 'antenna' | 'toggle';
  epc: string;
  known: boolean;
  item: NexusItem;
  location: string;
  rssi: number | null;
  antenna: number | null;
  antennas: number[];
  reads: number;
  passageId?: string | number | null;
  passageRequestId?: string | null;
  palletCode?: string | null;
  eventId?: string | null;
  /**
   * Set only on a contested exit. The movement is real and was reported anyway;
   * this says it must not be treated as a dispatch. Optional because a bridge
   * older than this field simply omits it.
   */
  unexpected?: OutboundFault | null;
  /**
   * Toggle mode only: WHY the direction was inferred — 'local-flip',
   * 'state-never-received', 'state-in-building', 'state-shipped-return' or
   * 'default-first-seen'. null/absent on observed (IR) passages.
   */
  basis?: string | null;
  timestamp: string;
}

/** Server heartbeat. Carries nothing — its arrival IS the payload. */
export interface PingMsg {
  type: 'ping';
  timestamp: string;
}

export interface PassageCompleteMsg {
  type: 'passage-complete';
  timestamp: string;
  passageId: string | number;
  processed: number;
  systemMs: number;
  assignment?: {
    palletCode?: string;
    cartonsAssigned?: number;
    location?: string;
  } | null;
}

export interface PalletWorkflowMsg {
  type: 'pallet-open' | 'pallet-ready' | 'pallet-print';
  timestamp: string;
  requestId: string;
  passageId: string | number;
  palletCode: string;
  cartonCount: number;
  queued: boolean;
  ok?: boolean;
  replayed?: boolean;
  error?: string;
  openedAt?: string;
  closesAt?: string;
  closeReason?: string;
}

export type WsMsg = TagMsg | GpiMsg | TriggerMsg | StatusMsg | LogMsg | UdpMsg | EntryMsg | PingMsg | PassageCompleteMsg | PalletWorkflowMsg;

export interface EntryRow extends Omit<EntryMsg, 'type'> {
  id: number;
  kind: 'entry' | 'exit';
}

export interface UdpFrameRow {
  id: number;
  raw: string;
  len: number;
  from: string;
  parsed: boolean;
  epc: string | null;
  timestamp: string;
}

export type PrinterTransport = 'usb' | 'tcp';

export interface PrinterConfig {
  transport: PrinterTransport;
  printerName: string;
  host: string;
  port: number;
  epcPrefix: string;
  barcode: boolean;
  widthDots: number | null;
  heightDots: number | null;
  topOffsetDots: number;
  leftOffsetDots: number;
  extraZpl: string;
  // Pallet-tag printer — a SEPARATE device from the CP30 above, driven with
  // TSPL. Sizes are mm (TSPL declares label size in mm, unlike the dot-based
  // ZPL fields); palletDpi must match the physical printhead or the design
  // prints at the wrong scale with no error.
  palletPrinterName: string;
  palletWidthMm: number;
  palletHeightMm: number;
  palletLeftOffsetMm: number;
  palletDpi: number;
}

export interface LastPrint {
  epc: string;
  at: string;
  transport: string;
  target?: string;
}

export interface PrinterStatusInfo {
  ok: boolean;
  config: PrinterConfig;
  nextEpc: string;
  lastPrint: LastPrint | null;
  /** Main (CP30) printer reachability. undefined = older bridge. */
  printerReady?: boolean;
  printerDetail?: string;
  /** Pallet-tag printer reachability — its own queue, its own verdict. */
  palletReady?: boolean;
  palletDetail?: string;
}

export interface PrintResult {
  ok: boolean;
  error?: string;
  epc: string;
  zpl: string;
  transport: string;
  target: string;
  jobId?: number;
  nextEpc?: string;
}

export interface TagRow {
  id: number;
  epc: string;
  antenna: number | null;
  rssi: number | null;
  timestamp: string;
}
