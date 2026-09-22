import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export type JobResult =
  | { status: "pending"; type?: "image" | "video"; userId?: string; phase?: string }
  | { status: "done"; imageUrl?: string; imageUrls?: string[]; videoUrl?: string }
  | { status: "error"; error: string };

const FILE = join(process.cwd(), ".job-store.json");

// Read-only filesystems (e.g. serverless) make the file store unusable. Entries
// are always mirrored here so a failed read or write degrades to memory instead
// of throwing.
const memory = new Map<string, JobResult>();

function read(): Record<string, JobResult> {
  let data: Record<string, JobResult> = {};
  try {
    if (existsSync(FILE)) data = JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    data = {};
  }
  for (const [taskId, result] of memory) data[taskId] = result;
  return data;
}

function write(data: Record<string, JobResult>): void {
  try {
    writeFileSync(FILE, JSON.stringify(data), "utf8");
  } catch {
    // memory already holds the entry — nothing further to do
  }
}

export const jobStore = {
  get(taskId: string): JobResult | undefined {
    return read()[taskId];
  },
  set(taskId: string, result: JobResult): void {
    memory.set(taskId, result);
    const data = read();
    data[taskId] = result;
    write(data);
  },
};
