/**
 * Hover intent for the paragraph menu.
 *
 * The dwell is counted per target, not per pointer position: moving inside the
 * same paragraph never restarts it, so the highlight appears while the pointer
 * is still travelling. Once something is already shown, switching to a
 * neighbour is faster still (the reader is clearly browsing).
 */
export const HOVER_COLD_DELAY = 70;
export const HOVER_WARM_DELAY = 35;
export const HOVER_CLOSE_DELAY = 320;
export const SCROLL_SETTLE_DELAY = 110;

export interface HoverIntent {
  /** Ask for `key` to be shown. `activate` receives a check that it is still wanted. */
  request(key: string, activate: (current: () => boolean) => void, options?: { warm?: boolean; immediate?: boolean }): void;
  /** Forget whatever is waiting. */
  cancel(): void;
  pendingKey(): string | undefined;
}

export function createHoverIntent(delays: { cold?: number; warm?: number } = {}): HoverIntent {
  const cold = delays.cold ?? HOVER_COLD_DELAY, warm = delays.warm ?? HOVER_WARM_DELAY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { key: string; activate: (current: () => boolean) => void } | undefined;
  let ticket = 0;
  const cancel = () => { ticket++; if (timer !== undefined) clearTimeout(timer); timer = undefined; pending = undefined; };
  const fire = () => {
    const target = pending, mine = ticket;
    timer = undefined; pending = undefined;
    target?.activate(() => mine === ticket);
  };
  return {
    request(key, activate, options = {}) {
      // Same target: keep the running dwell, only refresh what will be shown.
      if (pending?.key === key && !options.immediate) { pending.activate = activate; return; }
      cancel();
      pending = { key, activate };
      if (options.immediate) fire();
      else timer = setTimeout(fire, options.warm ? warm : cold);
    },
    cancel,
    pendingKey: () => pending?.key,
  };
}
