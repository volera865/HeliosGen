const RECORD_INFO = "https://api.kie.ai/api/v1/jobs/recordInfo";

export type KieRecordData = Record<string, unknown> & {
  state?: string;
  status?: string;
  failMsg?: string;
  error?: string;
  resultJson?: unknown;
};

export async function fetchKieRecordInfo(
  taskId: string,
  apiKey: string,
): Promise<{ ok: true; data: KieRecordData } | { ok: false; httpStatus?: number; apiCode?: number; msg?: string }> {
  const res = await fetch(`${RECORD_INFO}?taskId=${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });
  if (!res.ok) {
    return { ok: false, httpStatus: res.status };
  }
  const body = await res.json() as { code?: number; msg?: string; data?: KieRecordData };
  if (body.code !== undefined && body.code !== 200) {
    return { ok: false, apiCode: body.code, msg: body.msg };
  }
  return { ok: true, data: body.data ?? {} };
}

export function kieStateLower(data: KieRecordData): string {
  return String(data.state ?? data.status ?? "").toLowerCase();
}

export function isKieTerminalSuccess(state: string): boolean {
  return state === "success";
}

export function isKieTerminalFail(state: string): boolean {
  return state === "fail" || state === "failed" || state === "error";
}
