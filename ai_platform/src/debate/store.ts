import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { debatersOf, type DebateFormat, type DebateInput, type DebateRecord, type LogEntry } from "../types.js";

export class LockError extends Error {}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface DebateSummary {
  id: string;
  createdAt: string;
  topic: string;
  status: DebateRecord["status"];
  winner?: string;
  mock: boolean;
  /** 2 = 多辩手版（四辩制或公共论坛制）；旧版（每方一个辩手、共享证据池）的记录没有此字段 */
  version?: number;
  format?: DebateFormat;
}

/** 旧版记录只读展示，这里只用到各版本共有的字段。 */
export interface LegacyRecord {
  version?: undefined;
  id: string;
  createdAt: string;
  mock: boolean;
  status: DebateRecord["status"];
  input: DebateInput;
  verdict?: { winner: string };
  error?: string;
}

export type StoredRecord = DebateRecord | LegacyRecord;

/** 本次运行中创建的辩论保存在内存并推送给订阅者；每次更新同时落盘为 JSON，重启后仍可回看。 */
export class DebateStore {
  private records = new Map<string, DebateRecord>();
  private events = new EventEmitter();
  private writes = new Map<string, Promise<void>>();

  constructor(private dir: string) {
    this.events.setMaxListeners(0);
  }

  create(input: DebateInput, mock: boolean): DebateRecord {
    const record: DebateRecord = {
      version: 2,
      id: randomUUID().slice(0, 8),
      createdAt: new Date().toISOString(),
      mock,
      status: "running",
      stage: "research",
      input,
      debaters: debatersOf(input.format ?? "four").map((d) => ({ ...d, bank: [], searchCalls: [], rejectedPages: [], plans: [] })),
      turns: [],
      challenges: [],
      violations: [],
      judges: [],
      log: [],
    };
    this.records.set(record.id, record);
    this.update(record);
    return record;
  }

  /** 记录一条日志（可选）、落盘并通知订阅者。 */
  update(record: DebateRecord, message?: string, level: LogEntry["level"] = "info") {
    if (message) record.log.push({ time: new Date().toISOString(), level, message });
    this.persist(record);
    this.events.emit(record.id, record);
  }

  /** 这场辩论是否正在本进程中运行。 */
  isRunning(id: string): boolean {
    return this.records.get(id)?.status === "running";
  }

  /** 续跑一场中断的辩论：放回内存并恢复为进行中，已打开的页面重新订阅即可收到后续推送。 */
  resume(record: DebateRecord, message: string) {
    record.status = "running";
    delete record.error;
    delete record.activity;
    this.records.set(record.id, record);
    this.update(record, message);
  }

  /**
   * 跨进程锁：几个服务进程可能共用同一个数据目录（比如 3000 端口和 launch.json 里的 3101 端口），
   * 同一场辩论只能由一个进程运行。锁文件里是持有者的进程号，持有者已经退出的锁视为失效。
   */
  async lock(id: string) {
    await mkdir(this.dir, { recursive: true });
    const holder = Number.parseInt(await readFile(this.lockFile(id), "utf8").catch(() => ""), 10);
    if (holder && holder !== process.pid && processAlive(holder)) {
      throw new LockError(`这场辩论正由另一个服务进程（PID ${holder}）运行，请先关闭那个服务`);
    }
    await writeFile(this.lockFile(id), String(process.pid));
  }

  async unlock(id: string) {
    const holder = await readFile(this.lockFile(id), "utf8").catch(() => "");
    if (holder === String(process.pid)) await rm(this.lockFile(id), { force: true });
  }

  subscribe(id: string, listener: (record: DebateRecord) => void): () => void {
    this.events.on(id, listener);
    return () => this.events.off(id, listener);
  }

  async get(id: string): Promise<StoredRecord | undefined> {
    const cached = this.records.get(id);
    if (cached) return cached;
    if (!/^[\w-]+$/.test(id)) return undefined;
    let record: StoredRecord;
    try {
      record = JSON.parse(await readFile(this.file(id), "utf8")) as StoredRecord;
    } catch {
      return undefined;
    }
    // 磁盘上仍是 running 却不在内存里，说明服务在辩论途中重启过。
    if (record.status === "running") {
      record.status = "error";
      record.error = "服务在辩论进行中重启，本场辩论已中断";
    }
    return record;
  }

  async list(): Promise<DebateSummary[]> {
    await mkdir(this.dir, { recursive: true });
    const files = (await readdir(this.dir)).filter((f) => f.endsWith(".json"));
    const records = await Promise.all(files.map((f) => this.get(f.slice(0, -5))));
    return records
      .filter((r): r is StoredRecord => r !== undefined)
      .map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        topic: r.input.topic,
        status: r.status,
        winner: r.verdict?.winner,
        mock: r.mock,
        version: r.version,
        format: r.input.format ?? "four",
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private file(id: string) {
    return path.join(this.dir, `${id}.json`);
  }

  private lockFile(id: string) {
    return path.join(this.dir, `${id}.lock`);
  }

  // 同一场辩论的写入串行化，避免并发写出半截文件。
  private persist(record: DebateRecord) {
    const snapshot = JSON.stringify(record, null, 2);
    const previous = this.writes.get(record.id) ?? mkdir(this.dir, { recursive: true }).then(() => {});
    const next = previous
      .then(() => writeFile(this.file(record.id), snapshot))
      .catch((err) => console.error(`保存辩论 ${record.id} 失败：`, err));
    this.writes.set(record.id, next);
  }
}
