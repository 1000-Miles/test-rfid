export type Mode = 'manual' | 'ir' | 'hw';

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
  sku: string;
  name: string;
  pallet: string | null;
  category: string | null;
}

export interface EntryMsg {
  type: 'entry' | 'exit';
  direction: 'in' | 'out';
  method: 'antenna' | 'toggle';
  epc: string;
  known: boolean;
  item: NexusItem;
  location: string;
  rssi: number | null;
  antenna: number | null;
  antennas: number[];
  reads: number;
  timestamp: string;
}

export type WsMsg = TagMsg | GpiMsg | TriggerMsg | StatusMsg | LogMsg | UdpMsg | EntryMsg;

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
