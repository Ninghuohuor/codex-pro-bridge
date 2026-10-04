import { fail } from './errors.js';

const patterns: Array<[string, RegExp]> = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i],
  ['openai_key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/],
  ['github_token', /\bgh[pousr]_[A-Za-z0-9_]{25,}\b/],
  ['aws_key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['credential_assignment', /\b(?:password|passwd|api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*["']?[^\s"']{8,}/i]
];
export function scanText(text: string): void {
  for (const [kind, pattern] of patterns) if (pattern.test(text)) fail('CONTEXT_BLOCKED', `检测到可能的 ${kind}，已阻止外发。`);
  if (text.includes('\0')) fail('CONTEXT_BLOCKED', '内容包含二进制数据。');
}
export function safePreview(text: string, maxBytes = 1024): string {
  scanText(text);
  return Buffer.from(text).subarray(0,maxBytes).toString('utf8');
}
