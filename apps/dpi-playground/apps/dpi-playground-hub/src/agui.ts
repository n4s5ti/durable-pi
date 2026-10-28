// GET /api/agui: the network as an AG-UI state stream for read-only views (the web canvas, the
// Omarchy bar plugin). One shared projection; each connection gets RUN_STARTED and a
// STATE_SNAPSHOT, then the same STATE_DELTA every other connection gets. The route reads nothing
// from the client: a view that falls behind is dropped and resyncs from a fresh snapshot.
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import {
  diffState,
  projectCanvas,
  type AguiEvent,
  type CanvasState,
} from "../../../../dpi-sdk/src/agui.js";
import type { DeviceMonitor } from "./monitor.js";

export const AGUI_THREAD_ID = "dpi-network";
const MAX_BUFFERED = 1_000_000;

export class AguiFeed {
  private state: CanvasState;
  private clients = new Set<Response>();
  private off?: () => void;
  private ping?: ReturnType<typeof setInterval>;

  constructor(private readonly monitor: DeviceMonitor) {
    this.state = projectCanvas(monitor.network());
  }

  get size() {
    return this.clients.size;
  }

  start() {
    this.off = this.monitor.onChange(() => this.publish());
    this.ping = setInterval(() => {
      for (const res of this.clients) res.write(": ping\n\n");
    }, 15_000);
  }

  stop() {
    this.off?.();
    clearInterval(this.ping);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }

  open(req: Request, res: Response) {
    res.status(200).set({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    this.clients.add(res);
    req.on("close", () => this.clients.delete(res));
    this.send(res, { type: "RUN_STARTED", threadId: AGUI_THREAD_ID, runId: randomUUID() });
    this.send(res, { type: "STATE_SNAPSHOT", snapshot: this.state, timestamp: Date.now() });
  }

  private publish() {
    const next = projectCanvas(this.monitor.network());
    const delta = diffState(this.state, next);
    if (!delta.length) return;
    this.state = next;
    const event: AguiEvent = { type: "STATE_DELTA", delta, timestamp: Date.now() };
    for (const res of this.clients) this.send(res, event);
  }

  private send(res: Response, event: AguiEvent) {
    if (res.writableLength > MAX_BUFFERED) {
      this.clients.delete(res);
      res.end();
      return;
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}
