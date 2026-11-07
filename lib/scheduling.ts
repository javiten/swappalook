export function dateTimeInZone(value: string, timeZone: string): number | null {
  const wallTime = Date.parse(value + ':00Z')
  if (!Number.isFinite(wallTime)) return null
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  // Probe both sides of a possible daylight-saving transition.
  const offsets = [wallTime - 86400000, wallTime + 86400000].map(probe =>
    Date.parse(formatter.format(probe).replace(' ', 'T') + ':00Z') - probe
  )
  const candidates = [...new Set(offsets)].map(offset => wallTime - offset)
    .filter(instant => formatter.format(instant).replace(' ', 'T') === value)
  return candidates.length === 1 ? candidates[0] : null
}
