type NativeConfirm = (message?: string) => boolean | Promise<boolean>;

/** Tauri replaces window.confirm with an async dialog. Await it before acting. */
export async function acceptNativeConfirm(
  ask: NativeConfirm,
  message: string,
): Promise<boolean> {
  return Boolean(await ask(message));
}

export function nativeConfirm(message: string): Promise<boolean> {
  return acceptNativeConfirm(window.confirm as NativeConfirm, message);
}
