/**
 * The business calendar (banto-cost P8d, design §8・§10.1, review §8-5・§8-12):
 * today's business date in the company's time zone (Asia/Tokyo) and the
 * fiscal periods (6月開始、第13期 = 2026年6月〜2027年5月).
 *
 * Both come from the server (`GET /api/calendar` / Tauri
 * `business_calendar_get`, `admin_template_core::business_date`) so the
 * company's numbers live in one place (`cost_domain::FiscalCalendar`,
 * `BusinessTimeZone`). The app layout loads it once after sign-in; the
 * helpers below read it synchronously. Today is computed from the server's
 * clock (the device clock corrected by the difference seen at load, so a
 * device whose clock is off still agrees with the server) and the UTC offset,
 * so a page left open past midnight moves on to the next day without
 * reloading.
 *
 * Demo mode (no backend) or a failed load leaves the calendar unknown: the
 * date falls back to the device's local date and no period is shown.
 */
import { demoModeError, httpRequest, invokeCommand, isPipelineAvailable } from './pipelineAdmin';
import { getBantoMode } from './setup';

/** Mirrors `admin_template_core::business_date::FiscalPeriod`. */
export interface FiscalPeriod {
	period: number;
	/** `第13期（2026年6月〜2027年5月）`. */
	label: string;
	/** `YYYY-MM`. */
	firstMonth: string;
	/** `YYYY-MM`. */
	lastMonth: string;
}

/** Mirrors `admin_template_core::business_date::BusinessCalendar`. */
export interface BusinessCalendar {
	today: string;
	/** The server's clock when the calendar was made (UNIX ms). */
	nowMs: number;
	timeZone: string;
	utcOffsetMinutes: number;
	startMonth: number;
	basePeriod: number;
	baseStartYear: number;
	currentPeriod: number;
	periods: FiscalPeriod[];
}

export async function fetchBusinessCalendar(): Promise<BusinessCalendar> {
	if (!isPipelineAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') return invokeCommand<BusinessCalendar>('business_calendar_get');
	return httpRequest<BusinessCalendar>('/api/calendar', { method: 'GET' });
}

let calendar = $state<BusinessCalendar | null>(null);
/** The server's clock minus the device's, measured when the calendar arrived. */
let skewMs = 0;
let loading: Promise<void> | null = null;

/** How long the app layout waits for the calendar before going on without it. */
export const CALENDAR_WAIT_MS = 3000;

/**
 * Load the calendar once (the app layout calls this after sign-in). A failure
 * is not an error for the page: the helpers fall back, and the next call
 * tries again. The wait is bounded (`waitMs`): a stalled request does not
 * hold up navigation, and the calendar is used once it arrives.
 */
export function loadBusinessCalendar(waitMs: number = CALENDAR_WAIT_MS): Promise<void> {
	if (calendar) return Promise.resolve();
	loading ??= Promise.resolve()
		.then(() => (isPipelineAvailable() ? fetchBusinessCalendar() : null))
		.then((loaded) => {
			if (!loaded) return;
			skewMs = loaded.nowMs - Date.now();
			calendar = loaded;
		})
		.catch(() => {})
		.finally(() => {
			loading = null;
		});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, waitMs);
	});
	return Promise.race([loading, timeout]).finally(() => clearTimeout(timer));
}

/** The loaded calendar, or null (demo mode, not loaded yet, or failed). */
export function businessCalendar(): BusinessCalendar | null {
	return calendar;
}

/** Test hook: set (or clear) the loaded calendar and the clock difference. */
export function setBusinessCalendarForTest(value: BusinessCalendar | null, skew = 0): void {
	calendar = value;
	skewMs = skew;
}

/** The server's clock now (the device's without a calendar). */
function serverNow(deviceNowMs: number): number {
	return calendar ? deviceNowMs + skewMs : deviceNowMs;
}

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

/**
 * The date (`YYYY-MM-DD`) at `nowMs` (server clock) in the calendar's time
 * zone, or the device's local date without a calendar.
 */
export function businessDateAt(nowMs: number, cal: BusinessCalendar | null): string {
	if (!cal) {
		const d = new Date(nowMs);
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	}
	const d = new Date(nowMs + cal.utcOffsetMinutes * 60_000);
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Today's business date (`YYYY-MM-DD`); `nowMs` is the device's clock. */
export function businessToday(nowMs: number = Date.now()): string {
	return businessDateAt(serverNow(nowMs), calendar);
}

/** The fiscal period of a month (`YYYY-MM` or `YYYY-MM-DD`), as `FiscalCalendar::period_of`. */
export function periodOfMonth(month: string, cal: BusinessCalendar): number | null {
	const match = /^(\d{4})-(\d{2})/.exec(month);
	if (!match) return null;
	const year = Number(match[1]);
	const mo = Number(match[2]);
	if (mo < 1 || mo > 12) return null;
	const startYear = mo >= cal.startMonth ? year : year - 1;
	return cal.basePeriod + (startYear - cal.baseStartYear);
}

/** `第13期` for a month, or '' when the calendar or the month is unknown. */
export function periodName(month: string, cal: BusinessCalendar | null = calendar): string {
	if (!cal) return '';
	const period = periodOfMonth(month, cal);
	return period === null ? '' : `第${period}期`;
}

/** `2026-11（第13期）`, or the month alone when its period is unknown. */
export function monthWithPeriod(month: string, cal: BusinessCalendar | null = calendar): string {
	const name = periodName(month, cal);
	return name ? `${month}（${name}）` : month;
}

/** The current period, or null without a calendar; `nowMs` is the device's clock. */
export function currentPeriod(nowMs: number = Date.now()): number | null {
	if (!calendar) return null;
	return periodOfMonth(businessDateAt(serverNow(nowMs), calendar), calendar);
}
