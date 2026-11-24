import type { Status } from './types';

export type TransitionCheck = { ok: true } | { ok: false; reason: 'blocked' | 'invalid' };

/**
 * Status rules from the design:
 * - Starting or completing needs the task to be unblocked, unless overridden (the caller logs the reason).
 * - Pausing, cancelling and reopening are always allowed.
 */
export function checkTransition(from: Status, to: Status, blocked: boolean, override = false): TransitionCheck {
  if (from === to) return { ok: false, reason: 'invalid' };
  if ((to === 'in_progress' || to === 'done') && blocked && !override) return { ok: false, reason: 'blocked' };
  return { ok: true };
}

export const STATUS_LABELS: Record<Status, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};
