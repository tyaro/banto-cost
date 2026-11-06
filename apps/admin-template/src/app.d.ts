// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		interface Error {
			message: string;
			/**
			 * Set only by the startup deferral (Issue #321, `#lib/banto/startupGate.ts`):
			 * a protected route was opened before startup finished. The root layout
			 * shows the startup splash for it, never the error page.
			 */
			startupPending?: boolean;
		}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
