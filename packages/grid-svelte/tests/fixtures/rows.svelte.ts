/** Reactive provider rows for component tests (spec §4.1). */
export function createReactiveRows<TRow>(length: number) {
	const rows = $state<(TRow | undefined)[]>(new Array(length));
	return rows;
}
