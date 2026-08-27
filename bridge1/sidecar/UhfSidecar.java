import com.rscja.deviceapi.RFIDWithUHFNetworkUR4;
import com.rscja.deviceapi.entity.AntennaNameEnum;
import com.rscja.deviceapi.entity.AntennaPowerEntity;
import com.rscja.deviceapi.entity.AntennaState;
import com.rscja.deviceapi.entity.GPIStateEntity;
import com.rscja.deviceapi.entity.UHFTAGInfo;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Executors;

/**
 * UHF sidecar: exposes the Chainway Java SDK (pure-Java TCP path — works on
 * Windows AND Raspberry Pi/ARM) as a tiny local HTTP API for the Node bridge.
 *
 * Build:  javac -cp ReaderAPI20240822.jar UhfSidecar.java com/rscja/deviceapi/AntennaLink.java
 * Run:    java -cp "ReaderAPI20240822.jar;." UhfSidecar [port]     (Windows)
 *         java -cp "ReaderAPI20240822.jar:." UhfSidecar [port]     (Linux)
 *
 * All responses are JSON. Endpoints:
 *   POST /connect?ip=&port=      GET /status          POST /disconnect
 *   POST /inventory/start        POST /inventory/stop
 *   GET  /tags?max=200           (drains the callback queue)
 *   GET  /gpi                    GET /version
 *   GET  /power                  POST /power?dbm=&ants=1,2
 *   GET  /antennas               POST /antennas?ports=1,3
 *   GET  /antennas/link          (which ports have an antenna plugged in)
 *   GET  /workmode               POST /workmode?mode=0
 *   GET  /beep                   POST /beep?on=0        (0 = silence the reader)
 *   GET  /tag/single             (singulate ONE tag: pc + epc)
 *   POST /tag/read?bank=&ptr=&words=[&fbank=&fptr=&fdata=][&pwd=]
 *   POST /tag/write?bank=&ptr=&data=[&fbank=&fptr=&fdata=][&pwd=]
 *     Filter fields mirror the DLL driver: fptr is the mask offset in BITS,
 *     fdata is hex; the mask length is derived from fdata. No fdata = no
 *     filter (any tag in the field may answer — single-tag bench use only).
 */
public class UhfSidecar {
    static final RFIDWithUHFNetworkUR4 uhf = new RFIDWithUHFNetworkUR4();
    static final ConcurrentLinkedQueue<String> tagQueue = new ConcurrentLinkedQueue<>();
    static volatile boolean connected = false;
    static volatile boolean inventoryRunning = false;

    public static void main(String[] args) throws IOException {
        int port = args.length > 0 ? Integer.parseInt(args[0]) : 3010;
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.setExecutor(Executors.newSingleThreadExecutor()); // serialize SDK access

        server.createContext("/connect", ex -> handle(ex, q -> {
            String ip = q.getOrDefault("ip", "192.168.254.202");
            int p = Integer.parseInt(q.getOrDefault("port", "8888"));
            boolean ok = uhf.init(ip, p);
            connected = ok;
            return "{\"ok\":" + ok + "}";
        }));

        server.createContext("/disconnect", ex -> handle(ex, q -> {
            if (inventoryRunning) { uhf.stopInventory(); inventoryRunning = false; }
            boolean ok = uhf.free();
            connected = false;
            return "{\"ok\":" + ok + "}";
        }));

        server.createContext("/status", ex -> handle(ex, q ->
            "{\"ok\":true,\"connected\":" + connected + ",\"inventory\":" + inventoryRunning +
            ",\"queued\":" + tagQueue.size() + "}"));

        server.createContext("/version", ex -> handle(ex, q -> {
            String v = uhf.getVersion();
            return "{\"ok\":" + (v != null) + ",\"version\":" + jstr(v) + "}";
        }));

        server.createContext("/inventory/start", ex -> handle(ex, q -> {
            // mode=buffer skips the callback and relies on readTagFromBuffer
            // (the SDK offers exactly one of the two receive paths per run).
            boolean useCallback = !"buffer".equals(q.get("mode"));
            if (useCallback) {
                uhf.setInventoryCallback(info -> {
                    String tag = tagJson(info);
                    tagQueue.add(tag);
                    while (tagQueue.size() > 5000) tagQueue.poll(); // bound memory
                });
            } else {
                uhf.setInventoryCallback(null);
            }
            boolean ok = uhf.startInventoryTag();
            inventoryRunning = ok;
            return "{\"ok\":" + ok + ",\"receive\":\"" + (useCallback ? "callback" : "buffer") + "\"}";
        }));

        // drain via the deprecated buffer API (works when started with mode=buffer)
        server.createContext("/tags-buffer", ex -> handle(ex, q -> {
            int max = Integer.parseInt(q.getOrDefault("max", "200"));
            StringBuilder sb = new StringBuilder("{\"ok\":true,\"tags\":[");
            int n = 0;
            UHFTAGInfo info;
            while (n < max && (info = uhf.readTagFromBuffer()) != null) {
                if (n++ > 0) sb.append(',');
                sb.append(tagJson(info));
            }
            return sb.append("]}").toString();
        }));

        server.createContext("/inventory/stop", ex -> handle(ex, q -> {
            boolean ok = uhf.stopInventory();
            inventoryRunning = false;
            return "{\"ok\":" + ok + "}";
        }));

        server.createContext("/tags", ex -> handle(ex, q -> {
            int max = Integer.parseInt(q.getOrDefault("max", "200"));
            StringBuilder sb = new StringBuilder("{\"ok\":true,\"tags\":[");
            String t;
            int n = 0;
            while (n < max && (t = tagQueue.poll()) != null) {
                if (n++ > 0) sb.append(',');
                sb.append(t);
            }
            return sb.append("]}").toString();
        }));

        server.createContext("/gpi", ex -> handle(ex, q -> {
            List<GPIStateEntity> list = uhf.getGPI();
            if (list == null) return "{\"ok\":false}";
            StringBuilder sb = new StringBuilder("{\"ok\":true,\"gpi\":[");
            for (int i = 0; i < list.size(); i++) {
                GPIStateEntity g = list.get(i);
                if (i > 0) sb.append(',');
                sb.append("{\"name\":").append(jstr(g.getGPIName()))
                  .append(",\"state\":").append(g.getGPIState()).append('}');
            }
            return sb.append("]}").toString();
        }));

        server.createContext("/power", ex -> handle(ex, q -> {
            if ("POST".equals(ex.getRequestMethod())) {
                int dbm = Integer.parseInt(q.get("dbm"));
                boolean all = true;
                for (String s : q.getOrDefault("ants", "1").split(",")) {
                    AntennaNameEnum ant = AntennaNameEnum.getValue(Integer.parseInt(s.trim()));
                    if (ant != null) all &= uhf.setPower(ant, dbm);
                }
                return "{\"ok\":" + all + "}";
            }
            List<AntennaPowerEntity> list = uhf.getPowerAll();
            if (list == null) return "{\"ok\":false}";
            StringBuilder sb = new StringBuilder("{\"ok\":true,\"power\":[");
            for (int i = 0; i < list.size(); i++) {
                AntennaPowerEntity p = list.get(i);
                if (i > 0) sb.append(',');
                sb.append("{\"ant\":").append(p.getAntennaNameEnum().getValue())
                  .append(",\"dbm\":").append(p.getPower()).append('}');
            }
            return sb.append("]}").toString();
        }));

        // Which ports have an antenna PHYSICALLY connected. See AntennaLink.
        //
        // Never asked while tags are flowing. An antenna only changes when
        // somebody unplugs one, so there is no reason for a monitoring question
        // to share the wire with a pallet going through — it answers `busy` and
        // the caller keeps its previous reading. This is why the check does NOT
        // use withInventoryPaused the way GET /antennas does: pausing a live
        // gate to light a status dot is the wrong trade.
        server.createContext("/antennas/link", ex -> handle(ex, q -> {
            if (!connected) return "{\"ok\":false,\"error\":\"not connected\"}";
            if (inventoryRunning) return "{\"ok\":false,\"busy\":true}";
            byte[] raw = com.rscja.deviceapi.AntennaLink.ask(uhf);
            if (raw == null) return "{\"ok\":false,\"error\":\"no reply from reader\"}";
            return "{\"ok\":true,\"raw\":" + jstr(hex(raw)) + "}";
        }));

        server.createContext("/antennas", ex -> handle(ex, q -> {
            if ("POST".equals(ex.getRequestMethod())) {
                List<AntennaState> states = new ArrayList<>();
                List<Integer> want = new ArrayList<>();
                for (String s : q.getOrDefault("ports", "1").split(",")) want.add(Integer.parseInt(s.trim()));
                for (int i = 1; i <= 16; i++) {
                    AntennaNameEnum ant = AntennaNameEnum.getValue(i);
                    if (ant != null) states.add(new AntennaState(ant, want.contains(i)));
                }
                return "{\"ok\":" + uhf.setAntenna(states) + "}";
            }
            List<AntennaState> list = uhf.getAntenna();
            if (list == null) return "{\"ok\":false}";
            StringBuilder sb = new StringBuilder("{\"ok\":true,\"enabled\":[");
            boolean first = true;
            for (AntennaState s : list) {
                if (s.isEnable()) {
                    if (!first) sb.append(',');
                    sb.append(s.getAntennaName().getValue());
                    first = false;
                }
            }
            return sb.append("]}").toString();
        }));

        server.createContext("/tag/single", ex -> handle(ex, q -> {
            UHFTAGInfo info = uhf.inventorySingleTag();
            if (info == null) return "{\"ok\":true,\"tag\":null}";
            return "{\"ok\":true,\"tag\":{\"pc\":" + jstr(info.getPc()) +
                   ",\"epc\":" + jstr(info.getEPC()) + "}}";
        }));

        server.createContext("/tag/read", ex -> handle(ex, q -> {
            String pwd = q.getOrDefault("pwd", "00000000");
            int bank = Integer.parseInt(q.get("bank"));
            int ptr = Integer.parseInt(q.getOrDefault("ptr", "0"));
            int words = Integer.parseInt(q.getOrDefault("words", "1"));
            String fdata = q.get("fdata");
            String hex;
            if (fdata == null || fdata.isEmpty()) {
                hex = uhf.readData(pwd, bank, ptr, words);
            } else {
                int fbank = Integer.parseInt(q.getOrDefault("fbank", "1"));
                int fptr = Integer.parseInt(q.getOrDefault("fptr", "32")); // bits
                hex = uhf.readData(pwd, fbank, fptr, fdata.length() * 4, fdata, bank, ptr, words);
            }
            return "{\"ok\":" + (hex != null) + ",\"hex\":" + jstr(hex) + "}";
        }));

        server.createContext("/tag/write", ex -> handle(ex, q -> {
            String pwd = q.getOrDefault("pwd", "00000000");
            int bank = Integer.parseInt(q.get("bank"));
            int ptr = Integer.parseInt(q.getOrDefault("ptr", "0"));
            String data = q.get("data");
            if (data == null || data.isEmpty() || data.length() % 4 != 0)
                return "{\"ok\":false,\"error\":\"data must be whole 16-bit words of hex\"}";
            int words = data.length() / 4;
            String fdata = q.get("fdata");
            boolean ok;
            if (fdata == null || fdata.isEmpty()) {
                ok = uhf.writeData(pwd, bank, ptr, words, data);
            } else {
                int fbank = Integer.parseInt(q.getOrDefault("fbank", "1"));
                int fptr = Integer.parseInt(q.getOrDefault("fptr", "32")); // bits
                ok = uhf.writeData(pwd, fbank, fptr, fdata.length() * 4, fdata, bank, ptr, words, data);
            }
            return "{\"ok\":" + ok + "}";
        }));

        server.createContext("/workmode", ex -> handle(ex, q -> {
            if ("POST".equals(ex.getRequestMethod())) {
                int mode = Integer.parseInt(q.get("mode"));
                return "{\"ok\":" + uhf.setWorkMode(mode) + "}";
            }
            return "{\"ok\":true,\"mode\":" + uhf.getWorkMode() + "}";
        }));

        // Reader buzzer. The UR4 chirps on every single tag read out of the box,
        // which at a gate reading continuously is a solid tone all shift — so
        // this exists purely to shut it up: POST /beep?on=0.
        //
        // Persists in the reader, so it survives a power cycle and does NOT need
        // re-applying on connect.
        server.createContext("/beep", ex -> handle(ex, q -> {
            if ("POST".equals(ex.getRequestMethod())) {
                int on = Integer.parseInt(q.getOrDefault("on", "0"));
                return "{\"ok\":" + uhf.setBeep(on) + "}";
            }
            // getBeep returns the raw status characters; first one carries the
            // on/off flag. Null means the reader would not answer, which is not
            // the same as "off" and must not be reported as it.
            char[] b = uhf.getBeep();
            if (b == null || b.length == 0) return "{\"ok\":false}";
            return "{\"ok\":true,\"on\":" + ((int) b[0] != 0) + ",\"raw\":" + (int) b[0] + "}";
        }));

        server.start();
        System.out.println("[sidecar] listening on http://127.0.0.1:" + port);
    }

    // --- plumbing ---------------------------------------------------------

    interface Handler { String run(Map<String, String> query) throws Exception; }

    static void handle(HttpExchange ex, Handler h) throws IOException {
        String body;
        int code = 200;
        try {
            body = h.run(parseQuery(ex.getRequestURI().getRawQuery()));
        } catch (Exception e) {
            code = 500;
            body = "{\"ok\":false,\"error\":" + jstr(String.valueOf(e)) + "}";
        }
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json");
        ex.sendResponseHeaders(code, bytes.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(bytes); }
    }

    static Map<String, String> parseQuery(String raw) {
        Map<String, String> m = new HashMap<>();
        if (raw == null) return m;
        for (String kv : raw.split("&")) {
            int i = kv.indexOf('=');
            if (i > 0) m.put(kv.substring(0, i), java.net.URLDecoder.decode(kv.substring(i + 1), StandardCharsets.UTF_8));
        }
        return m;
    }

    static String tagJson(UHFTAGInfo info) {
        return "{\"epc\":" + jstr(info.getEPC()) +
               ",\"pc\":" + jstr(info.getPc()) +
               ",\"tid\":" + jstr(info.getTid()) +
               ",\"user\":" + jstr(info.getUser()) +
               ",\"ant\":" + jstr(info.getAnt()) +
               ",\"rssi\":" + jstr(info.getRssi()) +
               ",\"ts\":" + System.currentTimeMillis() + "}";
    }

    /** Bytes as uppercase hex, so the Node side can parse a reply this build has never seen. */
    static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format("%02X", x));
        return sb.toString();
    }

    static String jstr(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }
}
