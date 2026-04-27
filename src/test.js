const phases = [
  { startDate: '08/04/2026', endDate: '10/04/2026' },
  { startDate: '13/04/2026', endDate: '17/04/2026' },
];
function parseDate(str) {
  if (!str) return null;
  const [d, m, y] = str.split('/');
  return new Date(+y, +m - 1, +d);
}
function weekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}
  let allDates = [];
  phases.forEach(p => {
    const s = parseDate(p.startDate);
    const e = parseDate(p.endDate);
    if (s) allDates.push(s);
    if (e) allDates.push(e);
  });
  const minDate = weekStart(new Date(Math.min(...allDates)));
  const weeks = [];
  weeks.push(minDate);
  console.log("Min date:", minDate.toString());
