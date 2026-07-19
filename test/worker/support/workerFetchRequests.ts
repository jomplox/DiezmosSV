import worker from "../../../src/worker/index";
import type { Env } from "../../../src/worker/types";

export function executionContextCapturing(tasks: Promise<unknown>[]): ExecutionContext {
  return {
    waitUntil(promise: Promise<unknown>) {
      tasks.push(promise);
    },
    passThroughOnException() {}
  } as unknown as ExecutionContext;
}

export async function fetchAndWaitUntil(request: Request, runtime: Env): Promise<Response> {
  const tasks: Promise<unknown>[] = [];
  const response = await worker.fetch(request, runtime, executionContextCapturing(tasks));
  await Promise.all(tasks);
  return response;
}
