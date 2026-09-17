import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: ["req.headers.authorization", "headers.authorization"],
});

export const childLogger = (bindings: Record<string, string | number>) => logger.child(bindings);
