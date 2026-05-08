import pino from "pino";

export const log = pino({
  name: "forwarder",
  level: process.env.LOG_LEVEL ?? "info",
});
