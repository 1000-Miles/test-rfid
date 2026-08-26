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
  /**
   * No-IR only: count a carton on the read that decides it, instead of holding
   * it for the decision window. The window cannot change a no-IR outcome —
   * direction is inferred, not read — so what it buys is a fuller telemetry
   * picture on the receipt, at the cost of cartons reaching the board one at a
   * time. Undefined on a bridge that predates the control.
   */
  toggleFastCount?: boolean;
  /**
   * How long a pallet stays open for, in ms. Everything read inside the window
   * lands on the same pallet code and the same printed label, so this is what
   * separates one pallet from the next when there are no beams.
   */
  palletWindowMs?: number;
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
  /** Software read-zone floor in dBm (negative). null = off, every read kept. */
  minRssi?: number | null;
  /** Reads discarded by that floor since the bridge booted. */
  weakDropped?: number;
  gpi: GpiState;
  udp?: UdpState;
}

export interface MovementStatus {
  configured: boolean;
  queueDepth: number;
  oldestPendingAt: string | null;
  deadLetters: number;
  lastError: string | null;
  lastAccepted: {
    eventId: string | null;
    at: string;
    direction: 'in' | 'out' | null;
    epc: string | null;
    palletCode: string | null;
    passageId: string | number | null;
    unexpected: string | null;
    pending: boolean;
  } | null;
  journal: {
    healthy: boolean;
    corrupt: boolean;
    enqueueFailures: number;
    lastEnqueueError: string | null;
  };
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
 * Why a passage contradicts what Nexus knows. Decided by the bridge
 * (passage.js `_movementCheck`), null on every ordinary passage.
 *
 *   'no-open-batch'   inbound: no live receiving batch expects this product
 *   'not-received'    outbound: the carton was never taken in
 *   'already-shipped' outbound: the carton has already left
 */
export type MovementFault = 'no-open-batch' | 'not-received' | 'already-shipped';

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
   * Set only on a contested passage. The movement is real and was reported
   * anyway; this says it must not be treated as a receipt or a dispatch.
   * Optional because a bridge older than this field simply omits it.
   */
  unexpected?: MovementFault | null;
  /**
   * Toggle mode only: WHY the direction was inferred — 'local-flip',
   * 'state-never-received', 'state-in-building', 'state-shipped-return' or
   * 'default-first-seen'. null/absent on observed (IR) passages.
   */
  basis?: string | null;
  timestamp: string;
}

/**
 * Nexus withdrew some cartons — a receiving reset, or a batch deleted. The gate
 * has already corrected its own direction state; the boards use this to drop the
 * credits they are holding, which no document poll would ever tell them to do.
 */
export interface ReceivingResetMsg {
  type: 'receiving-reset';
  epcs: string[];
  count: number;
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

/** One product line on a pallet. `cartons` across all lines sums to cartonCount. */
export interface PalletProduct {
  sku: string;
  name: string;
  cartons: number;
}

export interface PalletWorkflowMsg {
  type: 'pallet-open' | 'pallet-ready' | 'pallet-print';
  timestamp: string;
  requestId: string;
  passageId: string | number;
  palletCode: string;
  /**
   * Receiving batch this pallet was assigned to.
   *
   * Absent until Nexus accepts the passage and assigns one, so it is null for
   * the whole time the pallet is open at the gate — and stays null while
   * delivery is failing. The UI must say "not assigned yet" rather than
   * substituting the pallet code, which would read as a batch it is not.
   */
  batchRef?: string | null;
  cartonCount: number;
  /** Absent on a reprint or a hand-keyed label, which have no cartons behind them. */
  products?: PalletProduct[];
  queued: boolean;
  ok?: boolean;
  replayed?: boolean;
  error?: string;
  openedAt?: string;
  closesAt?: string;
  closeReason?: string;
}

export type WsMsg = TagMsg | GpiMsg | TriggerMsg | StatusMsg | LogMsg | UdpMsg | EntryMsg | PingMsg | PassageCompleteMsg | PalletWorkflowMsg | ReceivingResetMsg;

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
  palletOrientation?: 'portrait' | 'landscape';
  /**
   * How the pallet printer is reached.
   *   'tcp'     — straight to the printer's own network port. Nothing else has
   *               to be switched on, so this is the better answer wherever the
   *               printer has an ethernet socket.
   *   'sidecar' — through a helper on the PC the printer is plugged into. Only
   *               needed for a USB-attached printer.
   */
  palletTransport?: 'tcp' | 'sidecar';
  /** Printer's own IP, for palletTransport 'tcp'. */
  palletHost?: string;
  palletTcpPort?: number;
  /** Address of the helper on the printer's PC, for 'sidecar'. Blank = print on
   *  the bridge's own machine. */
  palletSidecarUrl?: string;
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
