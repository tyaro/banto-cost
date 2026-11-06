export interface ErrorFixtureSettings {
	mode: 'client' | 'server';
	header: string;
	error: string;
	errorLabel: string;
	errorHint: string;
}

declare global {
	interface Window {
		gridErrorFixture: ErrorFixtureSettings;
	}
}
