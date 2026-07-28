'use strict';

/**
 * UDP listener for the reader's active tag output (hardware trigger / auto
 * work mode with param[5] = UDP). The reader pushes datagrams to the
 * destination configured via UHFSetDestIp; we simply bind that port here —
 * plain Node dgram, no DLL involvement.
 *
 * Emits:
 *   'listening' (port)
 *   'datagram'  ({ raw, len, from, parsed })   parsed = tag object or null
 *   'error'     (err)
 */

const dgram = require('dgram');
const EventEmitter = require('events');
const uhf = require('./uhf');

class UdpListener extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.port = null;
    this.frames = 0;
  }

  get listening() {
    return this.socket != null;
  }

  start(port) {
    if (this.socket) {
      if (this.port === port) return; // already bound where we want
      this.stop();
    }
    const sock = dgram.createSocket('udp4');
    sock.on('message', (buf, rinfo) => {
      this.frames++;
      let parsed = null;
      try {
        parsed = uhf.parseUdpDatagram(buf);
      } catch (_) {
        /* keep raw-only */
      }
      this.emit('datagram', {
        raw: buf.toString('hex').toUpperCase(),
        len: buf.length,
        from: `${rinfo.address}:${rinfo.port}`,
        parsed,
      });
    });
    sock.on('error', (err) => {
      this.emit('error', err);
      this.stop();
    });
    sock.bind(port, () => this.emit('listening', port));
    this.socket = sock;
    this.port = port;
  }

  stop() {
    if (!this.socket) return;
    try {
      this.socket.close();
    } catch (_) {
      /* already closed */
    }
    this.socket = null;
    this.port = null;
  }
}

module.exports = { UdpListener };
