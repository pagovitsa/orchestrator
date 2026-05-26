import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { paths } from "../config/env.js";
import { sendText } from "./response.js";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

export async function serveStatic(_req, res, url) {
  const target = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.resolve(paths.publicRoot, `.${target}`);
  if (filePath !== paths.publicRoot && !filePath.startsWith(`${paths.publicRoot}${path.sep}`)) {
    return sendText(res, 403, "Forbidden");
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return sendText(res, 404, "Not found");
    res.writeHead(200, { "content-type": contentTypes[path.extname(filePath)] || "application/octet-stream" });
    createReadStream(filePath).pipe(res);
  } catch {
    sendText(res, 404, "Not found");
  }
}
