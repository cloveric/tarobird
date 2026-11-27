import { sha256 } from "@noble/hashes/sha2.js";
import { registerPluginCryptoBackend } from "../../src/client-protocol/plugins.js";

registerPluginCryptoBackend({ sha256 });
