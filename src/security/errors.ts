export class BridgeError extends Error {
  constructor(public readonly code: string, message: string, public readonly next_action?: string) { super(message); this.name = 'BridgeError'; }
  toJSON() { return { code: this.code, safe_message: this.message, next_action: this.next_action ?? null }; }
}
export function fail(code: string, message: string, next_action?: string): never { throw new BridgeError(code, message, next_action); }
export function safeError(error: unknown) { return error instanceof BridgeError ? error.toJSON() : {code:'INTERNAL_ERROR',safe_message:'本地运行器发生错误，请运行 doctor。',next_action:'查看本地诊断，不要重复提交未知请求。'}; }
