package com.rscja.deviceapi;

/**
 * "Which antenna ports have an antenna plugged into them?"
 *
 * The Chainway Java SDK does not expose this. Its UR4 protocol class implements
 * commands 0x28-0x2B (antenna enable) and 0x4A-0x4D (antenna work time) and
 * stops there — which is why the sidecar's getAntennaLink() was a hardcoded
 * `return null`, and why every antenna in Control Tower read Unchecked.
 *
 * The READER supports it. The vendor's own UR4Demo shows it (ConfigForm.cs, the
 * "Antenna Connection State" button -> UHFAPI.dll UHFGetAntennaLinkStatus), and
 * that demo talks over TCPConnect — the same network path this sidecar uses, not
 * USB. Pointing that DLL at a fake reader on localhost and logging what it sent
 * gives the frame verbatim:
 *
 *     UHFGetANT                -> A5 5A 00 08 2A 22 0D 0A     (cmd 0x2A, known)
 *     UHFGetAntennaLinkStatus  -> A5 5A 00 08 4E 46 0D 0A     (cmd 0x4E)
 *
 * Frame is A5 5A <len:2> <cmd> [payload] <xor> 0D 0A, where len is the whole
 * frame and xor covers len+cmd+payload. So this sends those eight bytes down the
 * socket the SDK already holds — no second connection to a reader that only
 * accepts one.
 *
 * This class lives in com.rscja.deviceapi ONLY because that is what it takes to
 * reach RFIDWithUHFNetworkUR4.socketManage, which is protected. It reads; it
 * never writes a setting.
 *
 * It deliberately returns the RAW reply rather than a parsed port list. The
 * request frame is confirmed, the reply layout is not, and every rebuild of this
 * file means stopping the sidecar on a live gate. Handing the bytes to the Node
 * side means the parser can be corrected without touching the gate again.
 */
public final class AntennaLink {
    private AntennaLink() {}

    /** UHFGetAntennaLinkStatus, as UHFAPI.dll sends it. */
    private static final byte[] REQUEST = {
        (byte) 0xA5, (byte) 0x5A, 0x00, 0x08, 0x4E, 0x46, 0x0D, 0x0A
    };

    /**
     * Ask the reader, on the connection it already has.
     *
     * @return the raw reply bytes, or null if the socket is not up or the reader
     *         said nothing. Null is not "no antennas" — it is "no answer", and
     *         the caller must report it as such.
     */
    public static byte[] ask(RFIDWithUHFNetworkUR4 uhf) {
        if (uhf == null) return null;
        // protected field, same package — this is the whole reason for the package
        var socket = uhf.socketManage;
        if (socket == null) return null;
        var reply = socket.sendAndReceive(REQUEST);
        return reply == null ? null : reply.d;
    }
}
