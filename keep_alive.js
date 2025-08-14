const http = require("http");
const port = process.env.PORT;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("bot is running");
});

server.listen(port, () => console.log(`Keepalive HTTP listening on :${port}`));
