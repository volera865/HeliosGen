/** Shared message when the user stops an in-flight generation. */
export const STOPPED_BY_USER_MSG = "Stopped by user";

export function isStoppedErrorMessage(msg: string | undefined | null): boolean {
  return msg === STOPPED_BY_USER_MSG;
}
