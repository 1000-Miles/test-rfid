# UHF sidecar (Java)

Exposes the Chainway Java SDK as a small local HTTP API for the Node bridge.
This is the driver the gate actually uses on Linux/Pi — the `UHFAPI.dll` path
only works on Windows.

`UhfSidecar.class` is committed, so a normal deploy needs **no build**. You only
need to rebuild after editing `UhfSidecar.java`.

## Rebuild

Needs a JDK (`javac`), not just a runtime. This machine ships only a JRE:

```bash
sudo apt install -y openjdk-21-jdk-headless      # one time
cd bridge/sidecar
javac -cp ReaderAPI20240822.jar UhfSidecar.java  # writes UhfSidecar*.class
```

Then restart the sidecar so it loads the new classes:

```bash
pkill -f 'UhfSidecar' && cd bridge && npm run sidecar
```

## Symptom of a stale build

The bridge answers `501` with *"this sidecar build has no /beep route — rebuild
it"* for any endpoint the running `.class` predates. The Node side degrades to a
clear message rather than a silent no-op, so a stale sidecar looks like a stale
sidecar and not like broken hardware.

## Endpoints

See the comment block at the top of `UhfSidecar.java` — it is the authoritative
list.
