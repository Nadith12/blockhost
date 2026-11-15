export function aggregateProcessTreeUsage(rows = [], rootPids = [], logicalCpuCount = 1) {
  const normalized = rows.map((row) => ({
    pid: Number(row.pid),
    parentPid: Number(row.parentPid) || 0,
    cpuRaw: Math.max(0, Number(row.cpuRaw ?? row.cpuPercent) || 0),
    ramBytes: Math.max(0, Number(row.ramBytes) || 0),
  })).filter((row) => Number.isSafeInteger(row.pid) && row.pid > 0);
  const children = new Map();
  for (const row of normalized) {
    if (!children.has(row.parentPid)) children.set(row.parentPid, []);
    children.get(row.parentPid).push(row.pid);
  }
  const byPid = new Map(normalized.map((row) => [row.pid, row]));
  const cpuDivisor = Math.max(1, Number(logicalCpuCount) || 1);
  return rootPids.map(Number).map((rootPid) => {
    const pending = [rootPid];
    const included = new Set();
    while (pending.length) {
      const pid = pending.pop();
      if (included.has(pid)) continue;
      included.add(pid);
      pending.push(...(children.get(pid) || []));
    }
    let cpuRaw = 0;
    let ramBytes = 0;
    for (const pid of included) {
      const row = byPid.get(pid);
      if (!row) continue;
      cpuRaw += row.cpuRaw;
      ramBytes += row.ramBytes;
    }
    return {
      pid: rootPid,
      processCount: included.size,
      cpuPercent: Math.min(100, Math.round((cpuRaw / cpuDivisor) * 10) / 10),
      ramBytes,
    };
  });
}
