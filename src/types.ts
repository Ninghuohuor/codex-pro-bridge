export type TaskStatus = 'awaiting_approval' | 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type Delivery = 'not_sent' | 'maybe_sent' | 'confirmed_sent';
export type Phase = 'preflight' | 'compose' | 'submit' | 'wait' | 'capture' | 'reconcile';
export type Mode = 'ask' | 'plan' | 'review' | 'debug';
export type DiffMode = 'none' | 'staged' | 'unstaged' | 'both';
export interface FileSelection { path: string; start_line?: number; end_line?: number }
export interface Packet { id: string; project_id: string; sha256: string; content: string; manifest: FileSelection[]; diff_mode: DiffMode; revision: string; created_at: number; expires_at: number }
export interface Task { id: string; project_id: string; request_key: string; request_sha256: string; payload_sha256: string; payload: string | null; packet_id: string | null; session_id: string; conversation_url?: string | null; mode: Mode; status: TaskStatus; phase: Phase; delivery: Delivery; pause_reason: string | null; cancel_requested: boolean; created_at: number; updated_at: number }
export interface AdapterResult { text: string; conversation_url: string; route_before: string; route_after: string; association_verified: boolean; completion_verified: boolean; content_complete?: boolean; warnings: string[] }
