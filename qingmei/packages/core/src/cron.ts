/**
 * 五段式 cron（分 时 日 月 周）的解析与「下一次触发时刻」。
 *
 * 时区换算全部交给 Intl.DateTimeFormat：把目标时区的本地日历时间反推成 UTC
 * 时刻，再回读校验。由此得到两个性质：
 * - 夏令时跳过的本地时间（该本地时间不存在）判为不可触发，跳过；
 * - 夏令时重复的本地时间只取较早的那一次，一天只触发一次。
 *
 * 字段解析支持 `*`、`n`、`a-b`、`a,b`，以及区间后接步长（`/n`）；非法写法一律抛错，不静默兜底。
 */

export interface CronSpec {
  minute: number[]
  hour: number[]
  dayOfMonth: number[]
  month: number[]
  /** 已归一化：0 与 7 都是周日 */
  dayOfWeek: number[]
  /** 日字段是否限定（不以 `*` 开头）。日与周都限定时按 cron 惯例取「或」 */
  dayOfMonthRestricted: boolean
  dayOfWeekRestricted: boolean
}

interface CronField {
  label: string
  min: number
  max: number
}

const CRON_FIELDS: readonly CronField[] = [
  { label: '分', min: 0, max: 59 },
  { label: '时', min: 0, max: 23 },
  { label: '日', min: 1, max: 31 },
  { label: '月', min: 1, max: 12 },
  { label: '周', min: 0, max: 7 },
]

interface Day {
  year: number
  month: number
  day: number
}

interface WallClock extends Day {
  hour: number
  minute: number
  second: number
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** 覆盖闰日 2/29 最长的空档（2100 不是闰年，间隔 8 年） */
const MAX_SEARCH_DAYS = 366 * 9

// ────────────────────────────────────────────── 解析

export function parseCron(expression: string): CronSpec {
  if (typeof expression !== 'string') throw new TypeError('cron 表达式必须是字符串')
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`cron 表达式必须是 5 段（分 时 日 月 周），收到 ${parts.length} 段：「${expression}」`)
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [string, string, string, string, string]
  return {
    minute: parseField(minute, CRON_FIELDS[0]!),
    hour: parseField(hour, CRON_FIELDS[1]!),
    dayOfMonth: parseField(dayOfMonth, CRON_FIELDS[2]!),
    month: parseField(month, CRON_FIELDS[3]!),
    dayOfWeek: normalizeWeekdays(parseField(dayOfWeek, CRON_FIELDS[4]!)),
    dayOfMonthRestricted: !dayOfMonth.startsWith('*'),
    dayOfWeekRestricted: !dayOfWeek.startsWith('*'),
  }
}

function parseField(raw: string, field: CronField): number[] {
  if (raw === '') throw new Error(`cron 的${field.label}字段为空`)
  const values = new Set<number>()
  for (const term of raw.split(',')) {
    if (term === '') throw new Error(`cron 的${field.label}字段有空项：「${raw}」`)
    const [range, stepRaw, ...rest] = term.split('/')
    if (rest.length > 0) throw new Error(`cron 的${field.label}字段步长写法非法：「${term}」`)
    const step = stepRaw === undefined ? 1 : parseInteger(stepRaw, field, term)
    if (step < 1) throw new Error(`cron 的${field.label}字段步长必须 ≥ 1：「${term}」`)

    let low: number
    let high: number
    if (range === '*') {
      low = field.min
      high = field.max
    } else if (range.includes('-')) {
      const bounds = range.split('-')
      if (bounds.length !== 2 || bounds[0] === '' || bounds[1] === '') {
        throw new Error(`cron 的${field.label}字段范围写法非法：「${term}」`)
      }
      low = parseInteger(bounds[0], field, term)
      high = parseInteger(bounds[1], field, term)
    } else {
      low = parseInteger(range, field, term)
      // `n/step` 按「从 n 到上限」理解，与 Vixie cron 一致
      high = stepRaw === undefined ? low : field.max
    }

    if (low < field.min || high > field.max) {
      throw new Error(`cron 的${field.label}字段越界（${field.min}-${field.max}）：「${term}」`)
    }
    if (low > high) throw new Error(`cron 的${field.label}字段范围起点大于终点：「${term}」`)
    for (let value = low; value <= high; value += step) values.add(value)
  }
  return [...values].sort((a, b) => a - b)
}

function parseInteger(raw: string | undefined, field: CronField, term: string): number {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new Error(`cron 的${field.label}字段不是整数：「${term}」`)
  }
  return Number(raw)
}

function normalizeWeekdays(values: number[]): number[] {
  const normalized = new Set(values.map((value) => value % 7))
  return [...normalized].sort((a, b) => a - b)
}

// ────────────────────────────────────────────── 计算

/**
 * 严格晚于 `after` 的下一次触发时刻。
 *
 * @param expression 五段式 cron
 * @param after 起点（不含）；缺省为当前时间
 * @param timezone IANA 时区；缺省用进程时区
 */
export function nextCronTime(expression: string, after: Date = new Date(), timezone?: string): Date {
  const spec = parseCron(expression)
  const formatter = formatterFor(timezone?.trim() || systemTimeZone())

  const from = after.getTime()
  if (!Number.isFinite(from)) throw new TypeError('nextCronTime 的 after 必须是有效时间')

  const start = wallClockAt(from, formatter)
  const startMinuteOfDay = start.hour * 60 + start.minute
  const slots = timeSlots(spec)

  for (let offset = 0; offset <= MAX_SEARCH_DAYS; offset++) {
    const date = shiftDay(start, offset)
    if (!spec.month.includes(date.month)) continue
    if (!dayMatches(spec, date)) continue
    for (const slot of slots) {
      // 首日的更早时段不可能晚于 after，跳过以免做无意义的时区换算
      if (offset === 0 && slot < startMinuteOfDay) continue
      const instant = wallToInstant(date, Math.floor(slot / 60), slot % 60, formatter)
      if (instant !== null && instant > from) return new Date(instant)
    }
  }
  throw new Error(`cron 表达式「${expression}」在 ${MAX_SEARCH_DAYS} 天内没有可触发的时间`)
}

/** 目标时区的当前 IANA 时区名 */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function timeSlots(spec: CronSpec): number[] {
  const slots: number[] = []
  for (const hour of spec.hour) {
    for (const minute of spec.minute) slots.push(hour * 60 + minute)
  }
  return slots
}

function dayMatches(spec: CronSpec, date: Day): boolean {
  const dayOfMonthHit = spec.dayOfMonth.includes(date.day)
  const dayOfWeekHit = spec.dayOfWeek.includes(weekdayOf(date))
  // cron 惯例：日与周同时限定时取「或」，只限定一个时只看那一个
  if (spec.dayOfMonthRestricted && spec.dayOfWeekRestricted) return dayOfMonthHit || dayOfWeekHit
  if (spec.dayOfMonthRestricted) return dayOfMonthHit
  if (spec.dayOfWeekRestricted) return dayOfWeekHit
  return true
}

function weekdayOf(date: Day): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
}

function shiftDay(start: Day, offset: number): Day {
  const base = new Date(Date.UTC(start.year, start.month - 1, start.day + offset))
  return { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate() }
}

// ────────────────────────────────────────────── 时区换算

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone)
  if (cached) return cached
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    throw new Error(`无效的时区：${timeZone}`)
  }
  formatters.set(timeZone, formatter)
  return formatter
}

function wallClockAt(instant: number, formatter: Intl.DateTimeFormat): WallClock {
  const values: Record<string, number> = {}
  for (const part of formatter.formatToParts(new Date(instant))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value)
  }
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour!,
    minute: values.minute!,
    second: values.second!,
  }
}

function asUtcMs(wall: WallClock): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
}

/**
 * 把「目标时区的本地日历时间」换算成 UTC 时刻。
 *
 * 偏移量用本地时间与 UTC 时间之差推出来（不查表、不手写偏移）。
 * 取前后各一天的探测点，得到该时刻可能的两种偏移；能回读成同一本地时间的
 * 候选里取最早的一个。回读不成立说明这个本地时间不存在（夏令时跳过），返回 null。
 */
function wallToInstant(day: Day, hour: number, minute: number, formatter: Intl.DateTimeFormat): number | null {
  const target = Date.UTC(day.year, day.month - 1, day.day, hour, minute, 0, 0)
  const candidates = new Set<number>()
  for (const probe of [target - DAY_MS, target, target + DAY_MS]) {
    candidates.add(target - (asUtcMs(wallClockAt(probe, formatter)) - probe))
  }

  let earliest: number | null = null
  for (const candidate of candidates) {
    const wall = wallClockAt(candidate, formatter)
    if (wall.year !== day.year || wall.month !== day.month || wall.day !== day.day) continue
    if (wall.hour !== hour || wall.minute !== minute) continue
    if (earliest === null || candidate < earliest) earliest = candidate
  }
  return earliest
}
