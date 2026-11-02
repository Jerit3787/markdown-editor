const DAY = 86400000;

// window.MDE.formatRelativeTime — used by MenuBar.svelte's Open Recent
// submenu, CommandPalette.svelte's sublabels, and DocInfoPanel.svelte's
// Created/Edited rows (paired there with a full timestamp). One shared
// ladder for all three: bare "Today"/"Yesterday" for the last two days,
// then day/week/month buckets before falling back to a full date once
// "months ago" stops being a useful approximation.
export function formatRelativeTime(ts: number): string {
  // Calendar-day difference, not elapsed 24h windows: something typed at
  // 23:30 yesterday and viewed at 00:30 today is "Yesterday", not
  // "Today", and something two calendar days back is "2d ago" even if it
  // is only 25 hours old. Math.round absorbs the ±1h DST shift between
  // two local midnights.
  const startOfDay = (value: number) => {
    const d = new Date(value);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.max(0, Math.round((startOfDay(Date.now()) - startOfDay(ts)) / DAY));
  if (days < 1) return "Today";
  if (days < 2) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
