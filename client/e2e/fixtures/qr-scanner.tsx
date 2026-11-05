import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PairingCode, PairingScanner } from "../../src/PairingCode.js";
import { qrPublicCertificate } from "./qr-public-certificate.js";
import { installAttachmentDropGuard } from "../../src/attachment-drop.js";
function Fixture() {
  useEffect(installAttachmentDropGuard, []);
  const [open, setOpen] = useState(false), [received, setReceived] = useState("");
  return <>{new URLSearchParams(location.search).has("invite") && <PairingCode payload={{ v: 1, kind: "connect", hubPublicKey: "A".repeat(48), routes: [{ name: "Direct", url: "https://192.168.10.20:8788", certificateAuthority: qrPublicCertificate }] }}/>}<button onClick={(event) => { event.currentTarget.focus(); setReceived(""); setOpen(true); }}>Open scanner</button><output>{received}</output>{open && <PairingScanner initialMode={new URLSearchParams(location.search).has("image") ? "image" : "scan"} receive={(payload) => setReceived(JSON.stringify(payload))} close={() => setOpen(false)}/>}</>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture/></StrictMode>);
