import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The parser runs inside the server when an analysis starts. These load
  // grammar .wasm files from their own package folders at runtime, so they're
  // required from node_modules as-is rather than bundled away from those files.
  serverExternalPackages: ["web-tree-sitter", "tree-sitter-wasms", "tar"],
};

export default nextConfig;
