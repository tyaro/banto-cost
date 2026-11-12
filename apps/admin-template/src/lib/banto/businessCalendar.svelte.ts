/**
 * The business calendar (banto-cost P8d, design §8・§10.1, review §8-5・§8-12):
 * today's business date in the company's time zone (Asia/Tokyo) and the
 * fiscal periods (6月開始、第13期 = 2026年6月〜2027年5月).
 *
 * Both come from the server (`GET /api/calendar` / Tauri
 * `business_calendar_get`, `admin_template_core::business_date`) so the
 * company's numbers live in one place (`cost_domain::FiscalCalendar`,
 * `BusinessTimeZone`). The app layout loads it once after sign-in; the
 * helpers below read it synchronously. Today is computed from the clock with
 * the server's UTC offset, so a page left open past midnight moves on to the
 * next day without reloading.
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
let loading: Promise<void> | null = null;

/**
 * Load the calendar once (the app layout calls this after sign-in). A failure
 * is not an error for the page: the helpers fall back, and the next call
 * tries again.
 */
export function loadBusinessCalendar(): Promise<void> {
	if (calendar) return Promise.resolve();
	loading ??= Promise.resolve()
		.then(() => (isPipelineAvailable() ? fetchBusinessCalendar() : null))
		.then((loaded) => {
			if (loaded) calendar = loaded;
		})
		.catch(() => {})
		.finally(() => {
			loading = null;
		});
	return loading;
}

/** The loaded calendar, or null (demo mode, not loaded yet, or failed). */
export function businessCalendar(): BusinessCalendar | null {
	return calendar;
}

/** Test hook: set (or clear) the loaded calendar. */
export function setBusinessCalendarForTest(value: BusinessCalendar | null): void {
	calendar = value;
}

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

/**
 * The date (`YYYY-MM-DD`) at `nowMs` in the calendar's time zone, or the
 * device's local date without a calendar.
 */
export function businessDateAt(nowMs: number, cal: BusinessCalendar | null): string {
	if (!cal) {
		const d = new Date(nowMs);
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	}
	const d = new Date(nowMs + cal.utcOffsetMinutes * 60_000);
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Today's business date (`YYYY-MM-DD`). */
export function businessToday(nowMs: number = Date.now()): string {
	return businessDateAt(nowMs, calendar);
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

/** The current period, or null without a calendar. */
export function currentPeriod(nowMs: number = Date.now()): number | null {
	if (!calendar) return null;
	return periodOfMonth(businessDateAt(nowMs, calendar), calendar);
}
