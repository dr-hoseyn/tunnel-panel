import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ssh2 (via node-ssh, used for SSH auto-provisioning) ships native crypto
  // acceleration bindings Turbopack can't statically bundle -- fails with
  // "non-ecmascript placeable asset" otherwise. Left as a real require()
  // resolved from node_modules at runtime instead of being bundled.
  serverExternalPackages: ["ssh2", "node-ssh"],
};

export default nextConfig;
