import { useEffect, useState, type ReactNode } from 'react';
import { Clock3, X } from 'lucide-react';
import type { Status } from '../shared/types.ts';

export function CicadaReminder({
  status,
  open,
}: {
  status: () => Promise<Status>;
  open: () => void;
}): ReactNode {
  const [current, setCurrent] = useState<Status | null>(null),
    [dismissed, setDismissed] = useState('');
  useEffect(() => {
    let alive = true;
    const refresh = async (): Promise<void> => {
      try {
        const value = await status();
        if (alive) setCurrent(value);
      } catch {
        /* Reconnect on the next poll. */
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [status]);
  const day = new Date().toLocaleDateString('sv-SE');
  if (!current?.reminderPending || current.pausedUntil || dismissed === day) return null;
  return (
    <div className="cicada ci-reminder" role="status">
      <Clock3 size={18} />
      <span>Cicada · 今日尚未打卡</span>
      <button className="ci-button" onClick={open}>
        打开
      </button>
      <button
        className="ci-icon"
        aria-label="今日不再显示提醒"
        title="今日不再显示提醒"
        onClick={() => setDismissed(day)}
      >
        <X size={16} />
      </button>
    </div>
  );
}
