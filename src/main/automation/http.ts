import * as http from "node:http";
import * as net from "node:net";

export function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "http://127.0.0.1",
  });
  res.end(JSON.stringify(payload));
}

export function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    // Let Node's StringDecoder retain an incomplete UTF-8 sequence between
    // chunks. Calling Buffer#toString independently for each chunk corrupts a
    // Korean/emoji code point whenever the transport splits its bytes.
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { data += chunk; });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

export function listen(server: http.Server, preferredPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("error", onError);
      if (error.code === "EADDRINUSE") {
        server.listen(0, "127.0.0.1");
        return;
      }
      reject(error);
    };
    server.once("error", onError);
    server.on("listening", () => {
      server.off("error", onError);
      resolve((server.address() as net.AddressInfo).port);
    });
    server.listen(preferredPort, "127.0.0.1");
  });
}

